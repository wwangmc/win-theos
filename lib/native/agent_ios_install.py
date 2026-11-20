"""Send a local DEB to the on-device agent_ios MCP over USB or a configured URL."""

import argparse
import base64
from contextlib import contextmanager
import hashlib
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from agent_ios_usb import UsbForwarder


DEVICE_PORT = 9191
CHUNK_BYTES = 48 * 1024
PROTOCOL = '2025-11-25'


class MCPError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class AgentIOS:
    def __init__(self, url):
        parts = urlsplit(url)
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.path != '/mcp'
                or parts.username is not None or parts.password is not None or parts.query or parts.fragment):
            raise ValueError('AGENT_IOS_URL must be http(s)://host[:port]/mcp')
        self.url = url
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.index = 0
        self.protocol = None
        self.token = os.environ.get('AGENT_IOS_TOKEN')

    def exchange(self, payload, timeout=45):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        if self.protocol:
            headers['MCP-Protocol-Version'] = self.protocol
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        request = Request(self.url, method='POST', data=json.dumps(payload).encode('utf-8'), headers=headers)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                if 'id' not in payload and response.status == 202:
                    return None
                reply = json.loads(response.read())
        except HTTPError as exc:
            with exc:
                detail = exc.read(2048).decode('utf-8', 'replace')
            raise MCPError(f'agent_ios HTTP {exc.code}: {detail}') from exc
        except (URLError, OSError, ValueError, HTTPException) as exc:
            raise MCPError(f'agent_ios request failed: {exc}') from exc
        if not isinstance(reply, dict) or reply.get('id') != payload.get('id') or reply.get('jsonrpc') != '2.0':
            raise MCPError('Invalid JSON-RPC response from agent_ios')
        return reply

    def request(self, method, params, timeout=45, notification=False):
        self.index += 1
        payload = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if not notification:
            payload['id'] = self.index
        reply = self.exchange(payload, timeout)
        if reply is None:
            return None
        if reply.get('error'):
            raise MCPError(str(reply['error'].get('message', reply['error'])))
        if not isinstance(reply.get('result'), dict):
            raise MCPError(f'{method} returned an invalid result')
        return reply['result']

    def initialize(self):
        response = self.request('initialize', {
            'protocolVersion': PROTOCOL, 'capabilities': {},
            'clientInfo': {'name': 'win-theos', 'version': '1'},
        })
        protocol = response.get('protocolVersion')
        if protocol not in (PROTOCOL, '2025-06-18') or response.get('serverInfo', {}).get('name') != 'agent_ios':
            raise MCPError('Endpoint did not identify as a compatible agent_ios MCP')
        self.protocol = protocol
        self.request('notifications/initialized', {}, notification=True)

    def call(self, tool, arguments, timeout=45):
        result = self.request('tools/call', {'name': tool, 'arguments': arguments}, timeout=timeout)
        if result.get('isError'):
            message = '\n'.join(block.get('text', '') for block in result.get('content', ())
                                if block.get('type') == 'text')
            raise MCPError(message or f'{tool} failed')
        value = result.get('structuredContent')
        if not isinstance(value, dict):
            raise MCPError(f'{tool} returned invalid structured data')
        return value


@contextmanager
def connect_agent(udid=None, local_port=None):
    url = os.environ.get('AGENT_IOS_URL')
    if url:
        if udid:
            raise ValueError('Choose an explicit AGENT_IOS_URL or --udid for USB')
        yield AgentIOS(url)
        return
    with_host_port = local_port if local_port is not None else 0
    forward = UsbForwarder(with_host_port, DEVICE_PORT, udid or os.environ.get('AGENT_IOS_UDID'))
    with forward.run():
        yield AgentIOS(f'http://127.0.0.1:{forward.server_address[1]}/mcp')


def upload(client, path, bin_dirs):
    with path.open('rb') as handle:
        if handle.read(8) != b'!<arch>\n':
            raise ValueError('File is not a Debian ar archive')
        handle.seek(0)
        digest = hashlib.sha256()
        size = 0
        while block := handle.read(1024 * 1024):
            digest.update(block)
            size += len(block)
        checksum = digest.hexdigest()
        handle.seek(0)
        started = client.call('deb_begin', {'size': size, 'sha256': checksum, 'bin_dirs': bin_dirs})
        job = started['job_id']
        print(f'Uploading {path}\nJob {job}\nSHA-256 {checksum}', flush=True)
        offset = 0
        while block := handle.read(CHUNK_BYTES):
            acknowledgment = client.call('deb_chunk', {'job_id': job, 'offset': offset,
                                                        'data': base64.b64encode(block).decode('ascii')})
            offset += len(block)
            if acknowledgment.get('offset') != offset:
                raise MCPError(f'Device reported an unexpected upload offset for job {job}')
    return job


def install(client, args):
    client.initialize()
    job = args.job_id
    if not job:
        job = upload(client, args.deb, args.bin_dir)
        package = client.call('deb_stage', {'job_id': job})['package']
        print(f'Staged {package["Package"]} {package["Version"]} ({package["Architecture"]})', flush=True)
        try:
            client.call('deb_install', {'job_id': job})
        except MCPError as exc:
            print(f'Install submission reported an error: {exc}', file=sys.stderr, flush=True)

    deadline = time.monotonic() + args.wait
    while True:
        try:
            result = client.call('deb_status', {'job_id': job}, timeout=min(40, max(1, deadline - time.monotonic())))
        except MCPError as exc:
            last_problem = str(exc)
        else:
            status = result.get('result')
            if status == 'verified':
                package = result['package']
                print(f'Installed and verified {package["Package"]} {package["Version"]} '
                      f'({package["Architecture"]}), dpkg exit 0', flush=True)
                print(f'Phone log {result["remote_dir"]}/install.log', flush=True)
                return 0
            if status == 'failed_or_unverified':
                for key in ('install_log_tail', 'current_package'):
                    if result.get(key):
                        print(result[key], file=sys.stderr)
                raise MCPError(f'Job {job} failed verification (dpkg exit {result["dpkg_exit_code"]}). '
                               f'Phone log {result["remote_dir"]}/install.log')
            if status != 'running_or_unknown':
                raise MCPError(f'dpkg installation was not submitted for job {job} (state {status})')
            last_problem = 'Device did not report a completed installation'
        if time.monotonic() >= deadline:
            raise MCPError(f'Job {job} outcome is unresolved: {last_problem}\n'
                           f'Recheck using win-theos install --job-id {job}')
        time.sleep(min(2, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--deb', type=Path)
    source.add_argument('--job-id')
    parser.add_argument('--udid')
    parser.add_argument('--bin-dir', action='append', default=[])
    parser.add_argument('--wait', type=float, default=120)
    args = parser.parse_args()
    try:
        if not math.isfinite(args.wait) or args.wait <= 0:
            raise ValueError('--wait must be finite and positive')
        if args.job_id and not re.fullmatch(r'[0-9a-f]{32}', args.job_id):
            raise ValueError('--job-id must be the 32-character ID returned during upload')
        if args.deb and (not args.deb.is_file() or args.deb.suffix.lower() != '.deb'):
            raise ValueError('Pass an existing .deb file')
        local_port = int(os.environ.get('AGENT_IOS_LOCAL_PORT', str(DEVICE_PORT))) if not os.environ.get('AGENT_IOS_URL') else None
        if local_port is not None and not 1 <= local_port <= 65535:
            raise ValueError('AGENT_IOS_LOCAL_PORT must be a valid TCP port')
        with connect_agent(args.udid, local_port) as client:
            return install(client, args)
    except KeyboardInterrupt:
        return 130
    except (MCPError, OSError, ValueError, KeyError) as exc:
        print(f'win-theos install: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
