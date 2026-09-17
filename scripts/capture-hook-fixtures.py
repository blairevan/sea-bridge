#!/usr/bin/env python3
"""
Sea-Bridge Fixture Capture Server
Listens on the Sea-Bridge Hook Socket and records real hook payloads to disk.
Use this to capture real Codex Desktop Hook fixtures for contract testing.

Usage:
    cd /opt/app/aitools/sea-bridge
    python3 scripts/capture-hook-fixtures.py [--output-dir tests/fixtures/desktop/codex-hook/<version>]

The script listens on the Hook socket, saves each event payload to disk as JSON,
and responds with null output so Codex proceeds normally (no decision override).
Stop with Ctrl+C.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

SOCKET_ENV = "SEA_BRIDGE_HOOK_SOCKET"
SOCKET_DEFAULT = "~/Library/Application Support/SeaBridge/run/codex-hook.sock"
MAX_BYTES = 1024 * 1024


def expand(path: str) -> str:
    return str(Path(path).expanduser())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def recv_line(conn: socket.socket) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_BYTES:
            raise ValueError("payload exceeds 1 MiB")
        joined = b"".join(chunks)
        nl = joined.find(10)  # newline byte
        if nl >= 0:
            return joined[:nl]
    return b"".join(chunks)


def handle_connection(conn: socket.socket, output_dir: Path, counters: dict) -> None:
    try:
        raw = recv_line(conn)
        if not raw:
            return
        request = json.loads(raw.decode("utf-8"))
        invocation_id = request.get("invocationId", "unknown")
        event = request.get("event", {})
        event_name = event.get("hook_event_name", "unknown")
        if event_name not in counters:
            counters[event_name] = 0
        counters[event_name] += 1
        seq = counters[event_name]
        ts = datetime.now(timezone.utc).strftime("%H%M%S")
        filename = f"{event_name.lower()}-{seq:03d}-{ts}.json"
        fixture_path = output_dir / filename
        fixture = {
            "_capture_meta": {
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "socket_path": expand(os.environ.get(SOCKET_ENV, SOCKET_DEFAULT)),
                "event_name": event_name,
                "sequence": seq,
            },
            "request": request,
        }
        fixture_path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False))
        print(f"[{ts}] Captured {event_name} #{seq} -> {fixture_path}", file=sys.stderr)
        print(json.dumps(event, indent=2, ensure_ascii=False), file=sys.stderr)
        # Respond with null output so Codex proceeds with its native behavior
        response = {"protocolVersion": 1, "invocationId": invocation_id, "output": None}
        conn.sendall(json.dumps(response, separators=(",", ":")).encode("utf-8") + bytes([10]))
    except Exception as exc:
        print(f"[handler error] {exc}", file=sys.stderr)
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture real Codex Hook fixtures")
    parser.add_argument(
        "--output-dir",
        default="tests/fixtures/desktop/codex-hook/0.153.4",
        help="Directory to write captured fixtures",
    )
    args = parser.parse_args()
    socket_path = Path(expand(os.environ.get(SOCKET_ENV, SOCKET_DEFAULT)))
    output_dir = Path(args.output_dir)
    ensure_dir(output_dir)
    ensure_dir(socket_path.parent)
    os.chmod(socket_path.parent, 0o700)
    if socket_path.exists():
        socket_path.unlink()
    counters: dict = {}
    print("Sea-Bridge Fixture Capture Server", file=sys.stderr)
    print(f"Socket: {socket_path}", file=sys.stderr)
    print(f"Output: {output_dir.resolve()}", file=sys.stderr)
    print("Waiting for Codex Desktop Hook events... (Ctrl+C to stop)", file=sys.stderr)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv:
        os.chmod(socket_path.parent, 0o700)
        srv.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        srv.listen(10)
        try:
            while True:
                conn, _ = srv.accept()
                t = threading.Thread(
                    target=handle_connection,
                    args=(conn, output_dir, counters),
                    daemon=True,
                )
                t.start()
        except KeyboardInterrupt:
            pass
        finally:
            if socket_path.exists():
                socket_path.unlink()
    total = sum(counters.values())
    print(f"Capture complete. {total} events captured:", file=sys.stderr)
    for event_name, count in sorted(counters.items()):
        print(f"  {event_name}: {count}", file=sys.stderr)


if __name__ == "__main__":
    main()
