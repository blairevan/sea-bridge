#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket
import sys
import time
import uuid
from pathlib import Path

MAX_BYTES = 1024 * 1024


def expand(path: str) -> str:
    return str(Path(path).expanduser())


def debug(message: str) -> None:
    if os.environ.get("SEA_BRIDGE_HOOK_DEBUG") == "1":
        print(f"sea-bridge-hook: {message}", file=sys.stderr)


def timeout_for(event_name: str) -> float:
    if event_name == "PermissionRequest":
        return float(os.environ.get("SEA_BRIDGE_PERMISSION_HOOK_TIMEOUT_SECONDS", "30"))
    return float(os.environ.get("SEA_BRIDGE_HOOK_TIMEOUT_SECONDS", "5"))


def read_stdin() -> dict:
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("hook payload exceeds 1 MiB")
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("hook payload must be an object")
    if not payload.get("hook_event_name") or not payload.get("session_id"):
        raise ValueError("hook payload missing hook_event_name/session_id")
    return payload


def recv_line(sock: socket.socket) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_BYTES:
            raise ValueError("bridge response exceeds 1 MiB")
        joined = b"".join(chunks)
        newline = joined.find(b"\n")
        if newline >= 0:
            return joined[:newline]
    return b"".join(chunks)


def main() -> int:
    try:
        event = read_stdin()
        event_name = str(event["hook_event_name"])
        socket_path = expand(
            os.environ.get(
                "SEA_BRIDGE_HOOK_SOCKET",
                "~/Library/Application Support/SeaBridge/run/codex-hook.sock",
            )
        )
        invocation_id = str(uuid.uuid4())
        request = {
            "protocolVersion": 1,
            "invocationId": invocation_id,
            "sentAt": int(time.time() * 1000),
            "event": event,
        }

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout_for(event_name))
            sock.connect(socket_path)
            sock.sendall(json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n")
            raw = recv_line(sock)

        if not raw:
            return 0
        response = json.loads(raw.decode("utf-8"))
        if response.get("protocolVersion") != 1 or response.get("invocationId") != invocation_id:
            raise ValueError("bridge response envelope mismatch")
        output = response.get("output")
        if isinstance(output, dict):
            sys.stdout.write(json.dumps(output, separators=(",", ":")))
            sys.stdout.write("\n")
        return 0
    except Exception as exc:
        # Fail open to Codex's native behavior: no hook stdout means no external
        # decision/continuation. Do not emit guessed approval or stop semantics.
        debug(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
