"""Shared helpers for the HappyView maintenance tools (hv-deploy, hv-client).

Both run in two very different places — inside the compose project and on an
installed host — so the only thing that differs is how SQL is reached. The
caller supplies HV_PSQL (a command, shell-split) or a DSN in HV_DATABASE_URL /
DATABASE_URL.
"""

from __future__ import annotations

import os
import shlex
import subprocess


class ToolError(Exception):
    pass


def sql_command() -> list[str]:
    configured = os.environ.get("HV_PSQL")
    if configured:
        return shlex.split(configured)
    dsn = os.environ.get("HV_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if dsn:
        return ["psql", dsn]
    raise ToolError("set HV_PSQL, HV_DATABASE_URL or DATABASE_URL to apply SQL")


def run_sql(sql: str, variables: dict[str, str] | None = None) -> None:
    command = sql_command() + ["-q", "-v", "ON_ERROR_STOP=1"]
    for name, value in (variables or {}).items():
        command += ["-v", f"{name}={value}"]
    command += ["-f", "-"]
    result = subprocess.run(command, input=sql.encode(), capture_output=True)
    if result.returncode != 0:
        raise ToolError(
            f"{' '.join(command[:2])} failed:\n{result.stderr.decode(errors='replace').strip()}"
        )


def read_kv_file(path: str) -> dict[str, str]:
    """Parse a systemd EnvironmentFile-style KEY=value file."""
    values: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def write_env_file(path: str, values: dict[str, str], mode: int) -> None:
    """Atomically write a KEY=value file, keeping it readable only by its group.

    The caller is responsible for owning it (root:group on a host install), so
    the service user can read it without being able to rewrite it.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.new"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)
