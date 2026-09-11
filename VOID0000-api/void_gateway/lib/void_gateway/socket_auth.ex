defmodule VoidGateway.SocketAuth do
  @moduledoc """
  Validates Node-issued JWTs and checks Valkey session liveness on WebSocket upgrade.

  Phoenix does not own auth and does not issue tokens.
  This module only reads tokens issued by Node/Express and performs two checks:

    1. JWT signature + expiry
       Algorithm: HS256 with shared ACCESS_SECRET env var.
       Same secret Node uses in gateway/index.js authenticateUpgradeRequest().

    2. Valkey session identity/generation check: session:{userId}:{deviceId}
       A revoked session still has a valid JWT until the token expires.
       The Valkey key written by Node's sessionStore.js is the live source of truth.

       Pending sockets register before the second check and revalidate before
       IDENTIFY/RESUME, so revocation cannot miss an unidentified connection.

  Fails closed on Valkey errors — if the session liveness check cannot complete,
  the upgrade is rejected. Do not loosen this without explicit discussion.
  """

  require Logger

  @type auth :: %{
          user_id: String.t(),
          device_id: String.t(),
          token_exp: integer(),
          session_generation: String.t()
        }

  @spec verify_upgrade(Plug.Conn.t()) :: {:ok, auth()} | {:error, atom()}
  def verify_upgrade(conn) do
    conn = Plug.Conn.fetch_cookies(conn)

    with {:ok, token} <- extract_token(conn.cookies),
         {:ok, claims} <- verify_jwt(token),
         {:ok, auth} <- extract_claims(claims),
         :ok <- check_session_liveness(auth) do
      {:ok, auth}
    else
      {:error, reason} = err ->
        Logger.debug("[SocketAuth] Upgrade rejected: #{reason}")
        err
    end
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  defp extract_token(%{"accessToken" => token}) when is_binary(token) and token != "" do
    {:ok, token}
  end

  defp extract_token(_), do: {:error, :no_token}

  defp verify_jwt(token) do
    # ACCESS_SECRET is the raw HMAC key — same as how Node's jsonwebtoken uses it.
    # JOSE.JWK.from_oct treats the binary as the raw key bytes, not base64.
    secret = Application.fetch_env!(:void_gateway, :access_secret)
    jwk = JOSE.JWK.from_oct(secret)

    try do
      case JOSE.JWT.verify_strict(jwk, ["HS256"], token) do
        {true, %JOSE.JWT{fields: claims}, _jws} ->
          {:ok, claims}

        {false, _, _} ->
          {:error, :invalid_signature}
      end
    rescue
      e ->
        Logger.debug("[SocketAuth] JWT verify error: #{Exception.message(e)}")
        {:error, :invalid_token}
    end
  end

  # Matches Node token payload: { id, device_id, exp }
  # (jwt.js sets `id`, not `user_id`, as the subject claim)
  defp extract_claims(%{
         "id" => user_id,
         "device_id" => device_id,
         "exp" => exp,
         "sid" => sid,
         "type" => "access"
       })
       when is_binary(user_id) and user_id != "" and
              is_binary(device_id) and device_id != "" and is_binary(sid) and sid != "" do
    now = System.system_time(:second)

    cond do
      not is_integer(exp) ->
        {:error, :missing_exp}

      exp <= now ->
        {:error, :token_expired}

      true ->
        {:ok, %{user_id: user_id, device_id: device_id, token_exp: exp, session_generation: sid}}
    end
  end

  defp extract_claims(_), do: {:error, :invalid_claims}

  def check_session_liveness(%{session_generation: expected, token_exp: exp} = auth) do
    with true <- exp > System.system_time(:second),
         {:ok, ^expected} <- session_generation(auth) do
      :ok
    else
      _ -> {:error, :session_revoked}
    end
  end

  def check_session_liveness(_), do: {:error, :session_revoked}

  defp session_generation(%{user_id: user_id, device_id: device_id, session_generation: expected}) do
    # Key written by Node's sessionStore.js create() and deleted by revoke().
    key = "session:#{user_id}:#{device_id}"

    case Redix.command(:redix, ["MGET", key, "auth:revoked-session:#{expected}"]) do
      {:ok, [raw, nil]} when is_binary(raw) ->
        case Jason.decode(raw) do
          {:ok, %{"userId" => ^user_id, "deviceId" => ^device_id, "sessionId" => generation}}
          when is_binary(generation) and generation != "" ->
            {:ok, generation}

          _ ->
            {:error, :session_revoked}
        end

      {:ok, _} ->
        # Session was revoked (logout) but the JWT hasn't expired yet.
        # This is the gap that Node's own gateway doesn't currently catch.
        {:error, :session_revoked}

      {:error, reason} ->
        Logger.error("[SocketAuth] Valkey session check failed: #{inspect(reason)}")
        # Fail closed — do not accept upgrades when session liveness is unverifiable.
        {:error, :session_check_failed}
    end
  end
end
