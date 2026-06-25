"""Discover d3 services (host, director, plugin) on the network using DNS-SD (Zeroconf, mDNS, Bonjour) protocol.

\`pip install zeroconf\` is required before running this script.
"""
import json
import time
from zeroconf import Zeroconf, ServiceBrowser, ServiceListener
import socket
import argparse
import os

class ServiceInfo:
    def __init__(self, name, info):
        self.name = name
        self.addresses = set(socket.inet_ntoa(addr) for addr in info.addresses)
        self.port = info.port
        self.hostname = info.server
        self.properties = {k.decode("utf-8"): v.decode("utf-8") for k, v in info.properties.items() if k and v}

    def to_dict(self):
        return {
            "name": self.name,
            "addresses": list(self.addresses),
            "port": self.port,
            "hostname": self.hostname,
            "properties": self.properties
        }

class InfoListener(ServiceListener):
    def __init__(self, on_change_callback):
        self.services = {}
        self.on_change_callback = on_change_callback

    def _update_service(self, zeroconf, service_type, name):
        info = zeroconf.get_service_info(service_type, name)
        if info:
            self.services[name] = ServiceInfo(name, info)
            self.on_change_callback(self.services)

    def add_service(self, zeroconf, service_type, name):
        self._update_service(zeroconf, service_type, name)

    def update_service(self, zeroconf, service_type, name):
        self._update_service(zeroconf, service_type, name)

    def remove_service(self, zeroconf, service_type, name):
        if self.services.pop(name, None):
            self.on_change_callback(self.services)

def _machine_readable(services):
    services = [service.to_dict() for service in listener.services.values()]
    # Imprime la primera dirección descubierta en formato IP:PUERTO
    for svc in services:
        if svc["addresses"]:
            print(f"{svc['addresses'][0]}:{svc['port']}")
            return

def _human_readable(services):
    os.system('cls' if os.name == 'nt' else 'clear')
    services = [service.to_dict() for service in listener.services.values()]
    print(json.dumps(services, indent=4))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="D3 Director Scanner")
    parser.add_argument("service_type", choices=["director", "host", "plugin"], help="Service type to scan for")
    parser.add_argument("--output", choices=["human", "machine"], default="human", help="Output format: human-readable or single-line machine-parsable JSON")
    parser.add_argument("--once", action="store_true", help="Exit after first discovery (useful for scripting)")
    args = parser.parse_args()

    service_type = {
        "director": "_d3director._tcp.local.",
        "host": "_d3host._tcp.local.",
        "plugin": "_d3plugin._tcp.local."
    }[args.service_type]

    output_function = {
        "human": _human_readable,
        "machine": _machine_readable
    }[args.output]

    listener = InfoListener(output_function)
    zeroconf = Zeroconf()
    browser = ServiceBrowser(zeroconf, service_type, listener)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass # Treat this as normal program exit