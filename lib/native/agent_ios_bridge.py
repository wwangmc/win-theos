"""Bridge an agent's stdio MCP session to the phone's agent_ios endpoint over USB."""

import argparse
import json
import sys

from agent_ios_install import MCPError, connect_agent


def error_reply(identifier, code, message):
    return {'jsonrpc': '2.0', 'id': identifier, 'error': {'code': code, 'message': message}}


def handle(client, line):
    try:
        payload = json.loads(line)
    except (ValueError, UnicodeError):
        return error_reply(None, -32700, 'Parse error')
    if not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0' or not isinstance(payload.get('method'), str):
        return error_reply(payload.get('id') if isinstance(payload, dict) else None, -32600, 'Invalid request')
    try:
        reply = client.exchange(payload)
    except MCPError as exc:
        print(f'agent_ios: {exc}', file=sys.stderr, flush=True)
        if 'id' in payload:
            return error_reply(payload['id'], -32000, str(exc))
        return None
    if payload['method'] == 'initialize' and reply:
        negotiated = reply.get('result', {}).get('protocolVersion')
        if isinstance(negotiated, str):
            client.protocol = negotiated
    return reply


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--udid', help='Select a connected USB device')
    args = parser.parse_args()
    try:
        with connect_agent(args.udid) as client:
            for line in sys.stdin.buffer:
                reply = handle(client, line)
                if reply is not None:
                    sys.stdout.buffer.write(json.dumps(reply, separators=(',', ':')).encode('ascii') + b'\n')
                    sys.stdout.buffer.flush()
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError) as exc:
        print(f'agent_ios: {exc}', file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
