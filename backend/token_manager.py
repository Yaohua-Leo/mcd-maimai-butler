"""G1-MVP token lifecycle contract.

This module is a local, in-memory encrypted vault used to verify lifecycle
semantics before a CloudBase identity-aware backend is selected. It never
persists plaintext tokens and never returns them as API data. Production use
still requires a managed per-user identity, durable secret storage, and a
CloudBase/KMS-backed key; this class intentionally refuses to imply those
guarantees.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Mapping

from cryptography.fernet import Fernet, InvalidToken

from .mcp_client import McpClientError, ReadOnlyMcpClient


class TokenLifecycleError(RuntimeError):
    """A safe, user-facing token lifecycle error without secret material."""


@dataclass(frozen=True)
class TokenMetadata:
    user_id: str
    status: str
    bound_at: str | None = None
    last_validated_at: str | None = None
    invalidated_at: str | None = None
    disconnected_at: str | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class EncryptedTokenVault:
    """In-memory Fernet vault for local contract tests and development."""

    def __init__(self, key: bytes) -> None:
        try:
            self._fernet = Fernet(key)
        except (TypeError, ValueError) as exc:
            raise TokenLifecycleError("MCD token vault key is invalid") from exc
        self._ciphertexts: dict[str, bytes] = {}

    def put(self, user_id: str, token: str) -> None:
        if not user_id.strip() or not token.strip():
            raise TokenLifecycleError("user_id and token are required")
        self._ciphertexts[user_id] = self._fernet.encrypt(token.encode("utf-8"))

    def get(self, user_id: str) -> str | None:
        ciphertext = self._ciphertexts.get(user_id)
        if ciphertext is None:
            return None
        try:
            return self._fernet.decrypt(ciphertext).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise TokenLifecycleError("stored MCP token cannot be decrypted") from exc

    def delete(self, user_id: str) -> None:
        self._ciphertexts.pop(user_id, None)


class TokenManager:
    """Manage token lifecycle without exposing plaintext to callers."""

    def __init__(
        self,
        vault: EncryptedTokenVault,
        validator: Callable[[str], bool],
    ) -> None:
        self._vault = vault
        self._validator = validator
        self._metadata: dict[str, TokenMetadata] = {}

    def metadata(self, user_id: str) -> TokenMetadata | None:
        return self._metadata.get(user_id)

    def bind(self, user_id: str, token: str) -> TokenMetadata:
        """Validate first, then atomically replace the existing token."""

        if not user_id.strip() or not token.strip():
            raise TokenLifecycleError("user_id and token are required")
        try:
            valid = bool(self._validator(token))
        except Exception as exc:  # validator must not leak provider details
            raise TokenLifecycleError("MCP token validation failed") from exc
        if not valid:
            previous = self._metadata.get(user_id)
            invalid = TokenMetadata(
                user_id=user_id,
                status="invalid",
                bound_at=previous.bound_at if previous else None,
                invalidated_at=_now(),
            )
            if previous and previous.status == "active":
                # Keep the prior active binding when a replacement token fails.
                return previous
            self._metadata[user_id] = invalid
            self._vault.delete(user_id)
            raise TokenLifecycleError("MCP token validation failed")

        now = _now()
        self._vault.put(user_id, token)
        metadata = TokenMetadata(user_id=user_id, status="active", bound_at=now, last_validated_at=now)
        self._metadata[user_id] = metadata
        return metadata

    def mark_invalid(self, user_id: str) -> TokenMetadata:
        current = self._metadata.get(user_id)
        if current is None:
            metadata = TokenMetadata(user_id=user_id, status="invalid", invalidated_at=_now())
        else:
            metadata = TokenMetadata(
                user_id=user_id,
                status="invalid",
                bound_at=current.bound_at,
                last_validated_at=current.last_validated_at,
                invalidated_at=_now(),
            )
        self._metadata[user_id] = metadata
        self._vault.delete(user_id)
        return metadata

    def disconnect(self, user_id: str) -> TokenMetadata:
        current = self._metadata.get(user_id)
        metadata = TokenMetadata(
            user_id=user_id,
            status="disconnected",
            bound_at=current.bound_at if current else None,
            last_validated_at=current.last_validated_at if current else None,
            disconnected_at=_now(),
        )
        self._vault.delete(user_id)
        self._metadata[user_id] = metadata
        return metadata

    def delete(self, user_id: str) -> None:
        """Delete ciphertext and lifecycle metadata; callers receive no token data."""

        self._vault.delete(user_id)
        self._metadata.pop(user_id, None)

    def require_active_token(self, user_id: str) -> str:
        metadata = self._metadata.get(user_id)
        if metadata is None or metadata.status != "active":
            raise TokenLifecycleError("MCP token is not active")
        token = self._vault.get(user_id)
        if not token:
            self.mark_invalid(user_id)
            raise TokenLifecycleError("MCP token is not active")
        return token


def metadata_dict(metadata: TokenMetadata | None) -> Mapping[str, str | None] | None:
    """Serialize only non-secret lifecycle metadata for a response."""

    if metadata is None:
        return None
    return {
        "userId": metadata.user_id,
        "status": metadata.status,
        "boundAt": metadata.bound_at,
        "lastValidatedAt": metadata.last_validated_at,
        "invalidatedAt": metadata.invalidated_at,
        "disconnectedAt": metadata.disconnected_at,
    }


def validate_with_mcp(token: str, *, timeout: int = 10) -> bool:
    """Validate a user token with one harmless read-only MCP call."""

    try:
        client = ReadOnlyMcpClient(token=token, timeout=timeout)
        client.initialize()
        client.call_read_only("now-time-info", {})
    except McpClientError:
        return False
    return True
