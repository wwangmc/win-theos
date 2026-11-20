"""Forward an agent_ios port through the host's USBMux service."""

from contextlib import contextmanager
import os
import plistlib
import select
import socket
from socketserver import BaseRequestHandler, ThreadingTCPServer
import struct
from threading import Lock, Thread


USBMUX_HEADER = struct.Struct('<IIII')
USBMUX_TIMEOUT = 3


def open_usb_service():
    address = os.environ.get('USBMUXD_SOCKET_ADDRESS')
    try:
        if address and not address.startswith('/'):
            host, port = address.rsplit(':', 1)
            return socket.create_connection((host.strip('[]'), int(port)), USBMUX_TIMEOUT)
        if os.name == 'nt' and address is None:
            return socket.create_connection(('127.0.0.1', 27015), USBMUX_TIMEOUT)
        connection = socket.socket(socket.AF_UNIX)
        try:
            connection.settimeout(USBMUX_TIMEOUT)
            connection.connect(address or '/var/run/usbmuxd')
            return connection
        except OSError:
            connection.close()
            raise
    except (OSError, ValueError) as exc:
        raise OSError(f'Cannot connect to Apple Mobile Device Service / usbmuxd: {exc}') from exc


def read_exact(connection, size):
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise OSError('USBMux closed the connection during negotiation')
        data.extend(chunk)
    return bytes(data)


def exchange(connection, **request):
    payload = plistlib.dumps({**request, 'ProgName': 'agent_ios',
                              'ClientVersionString': 'win-theos', 'kLibUSBMuxVersion': 3})
    connection.sendall(USBMUX_HEADER.pack(USBMUX_HEADER.size + len(payload), 1, 8, 1) + payload)
    size, version, kind, tag = USBMUX_HEADER.unpack(read_exact(connection, USBMUX_HEADER.size))
    if (version, kind, tag) != (1, 8, 1) or not USBMUX_HEADER.size <= size <= 1024 * 1024:
        raise OSError('Unexpected USBMux response header')
    try:
        result = plistlib.loads(read_exact(connection, size - USBMUX_HEADER.size))
    except (ValueError, plistlib.InvalidFileException) as exc:
        raise OSError('Invalid USBMux response') from exc
    if not isinstance(result, dict):
        raise OSError('Invalid USBMux response')
    return result


class UsbForwarder(ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = os.name != 'nt'

    def __init__(self, local_port, device_port, udid=None):
        self.device_port = device_port
        self.udid = udid
        self.device_lock = Lock()
        super().__init__(('127.0.0.1', local_port), ForwardConnection)

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            super().server_bind()
        except OSError as exc:
            raise OSError(f'Cannot bind USB forward on 127.0.0.1:{self.server_address[1]}: {exc}') from exc

    def device_id(self):
        with self.device_lock:
            with open_usb_service() as connection:
                reply = exchange(connection, MessageType='ListDevices')
            if 'DeviceList' not in reply:
                raise OSError(f'USBMux device listing failed (code {reply.get("Number")})')
            devices = {
                props['SerialNumber']: info['DeviceID']
                for info in reply['DeviceList']
                if (props := info.get('Properties', {})).get('ConnectionType') == 'USB'
                and props.get('SerialNumber')
            }
            if self.udid is None:
                if not devices:
                    raise OSError('No USB iPhone or iPad detected. Connect, unlock and trust the computer.')
                if len(devices) != 1:
                    raise OSError(f'Multiple USB devices. Select a UDID from: {", ".join(sorted(devices))}')
                self.udid = next(iter(devices))
            for serial, device_id in devices.items():
                if serial.casefold() == self.udid.casefold():
                    return device_id
            raise OSError(f'Selected USB device {self.udid} is disconnected')

    @contextmanager
    def connect_device(self):
        device_id = self.device_id()
        with open_usb_service() as connection:
            reply = exchange(connection, MessageType='Connect', DeviceID=device_id,
                             PortNumber=socket.htons(self.device_port))
            if reply.get('MessageType') != 'Result' or reply.get('Number') != 0:
                raise OSError(f'USB connection to device port {self.device_port} failed (code {reply.get("Number")}). '
                              'Check computer trust and whether agent_ios is running on the phone.')
            connection.settimeout(None)
            yield connection

    @contextmanager
    def run(self):
        with self:
            thread = Thread(target=self.serve_forever, kwargs={'poll_interval': 0.1}, daemon=True)
            thread.start()
            try:
                yield
            finally:
                self.shutdown()
                thread.join()


class ForwardConnection(BaseRequestHandler):
    def handle(self):
        connected = False
        try:
            self.request.settimeout(60)
            with self.server.connect_device() as remote:
                connected = True
                remote.settimeout(60)
                relay(self.request, remote)
        except OSError as exc:
            if not connected:
                body = str(exc).encode('utf-8')
                headers = ('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n'
                           f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n').encode('ascii')
                try:
                    self.request.sendall(headers + body)
                    # Drain the pending HTTP request to let the client receive the error.
                    self.request.shutdown(socket.SHUT_WR)
                    self.request.settimeout(0.2)
                    while self.request.recv(65536):
                        pass
                except OSError:
                    pass


def relay(local, remote):
    peers = {local: remote, remote: local}
    reading = list(peers)
    while reading:
        ready, _, _ = select.select(reading, [], [], 60)
        if not ready:
            return
        for source in ready:
            target = peers[source]
            chunk = source.recv(65536)
            if chunk:
                target.sendall(chunk)
            else:
                target.shutdown(socket.SHUT_WR)
                reading.remove(source)
