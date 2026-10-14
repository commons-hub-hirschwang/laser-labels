#!/usr/bin/env python3
"""List USB devices in USBPcap captures or extract one VID:PID with tshark."""

import argparse
import re
import subprocess
import sys
from pathlib import Path


FIELDS = ["usb.bus_id", "usb.device_address", "usb.idVendor", "usb.idProduct"]


def devices(capture: Path) -> set[tuple[str, str, str, str]]:
    result = subprocess.run(
        [
            "tshark", "-r", str(capture), "-Y", "usb.idVendor && usb.idProduct",
            "-T", "fields", *sum((["-e", field] for field in FIELDS), []),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return {
        tuple(column.lower() for column in line.split("\t"))
        for line in result.stdout.splitlines()
        if len(line.split("\t")) == 4
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    listing = commands.add_parser("list", help="list distinct USB devices")
    listing.add_argument("captures", nargs="+", type=Path)

    filtering = commands.add_parser("filter", help="extract a device from captures")
    filtering.add_argument("--device", required=True, help="vendor:product, e.g. 28e9:018a")
    filtering.add_argument("--out-dir", type=Path, default=Path("filtered"))
    filtering.add_argument("captures", nargs="+", type=Path)
    args = parser.parse_args()

    if not shutil_which("tshark"):
        parser.error("tshark is required but was not found on PATH")

    try:
        if args.command == "list":
            for capture in args.captures:
                print(f"{capture}:")
                for bus, address, vendor, product in sorted(devices(capture)):
                    print(f"  bus {bus}, address {address}: {vendor}:{product}")
            return 0

        match = re.fullmatch(r"(?:0x)?([0-9a-fA-F]{4}):(?:0x)?([0-9a-fA-F]{4})", args.device)
        if not match:
            parser.error("--device must be a VID:PID pair of four-digit hex values")
        vendor, product = (f"0x{part.lower()}" for part in match.groups())
        args.out_dir.mkdir(parents=True, exist_ok=True)
        for capture in args.captures:
            addresses = sorted(
                {address for _, address, vid, pid in devices(capture) if (vid, pid) == (vendor, product)},
                key=int,
            )
            if not addresses:
                print(f"{capture}: {args.device} not found", file=sys.stderr)
                continue
            display_filter = " || ".join(f"usb.device_address == {address}" for address in addresses)
            output = args.out_dir / f"{capture.stem}-{match.group(1).lower()}-{match.group(2).lower()}.pcapng"
            subprocess.run(
                ["tshark", "-r", str(capture), "-Y", display_filter, "-w", str(output)],
                check=True,
            )
            print(f"{capture}: extracted device {args.device} (address {', '.join(addresses)}) to {output}")
        return 0
    except (OSError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        return 1


def shutil_which(command: str) -> str | None:
    from shutil import which

    return which(command)


if __name__ == "__main__":
    raise SystemExit(main())
