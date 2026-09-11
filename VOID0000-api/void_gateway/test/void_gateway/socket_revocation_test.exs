defmodule VoidGateway.SocketRevocationTest do
  use ExUnit.Case, async: false
  alias VoidGateway.{SocketAuth, ConnectionRegistry}
  alias VoidGatewayWeb.Handlers.SocketHandler

  setup do
    user = "security-#{System.unique_integer([:positive])}"
    key = "session:#{user}:device"

    auth = %{
      user_id: user,
      device_id: "device",
      token_exp: System.system_time(:second) + 60,
      session_generation: "session-a"
    }

    {:ok, "OK"} =
      Redix.command(:redix, [
        "SET",
        key,
        Jason.encode!(%{userId: user, deviceId: "device", sessionId: "session-a"})
      ])

    on_exit(fn ->
      Redix.command(:redix, ["DEL", key])
    end)

    %{auth: auth, key: key}
  end

  test "revocation between upgrade and init rejects the pending socket", %{auth: auth, key: key} do
    Redix.command(:redix, ["DEL", key])
    assert {:stop, _, _, state} = SocketHandler.init(auth)
    SocketHandler.terminate(:normal, state)
    assert ConnectionRegistry.lookup(auth.user_id, "device") == []
  end

  test "connection capacity closes retryably without claiming authentication failed", %{
    auth: auth
  } do
    sockets = for _ <- 1..8, do: spawn(fn -> Process.sleep(:infinity) end)

    on_exit(fn -> Enum.each(sockets, &Process.exit(&1, :kill)) end)

    for pid <- sockets do
      assert :ok = ConnectionRegistry.register_pending(auth.user_id, "device", pid)
    end

    assert {:stop, :normal, {1013, "Connection limit reached"}, state} = SocketHandler.init(auth)
    SocketHandler.terminate(:normal, state)
    assert length(ConnectionRegistry.lookup(auth.user_id, "device")) == 8
  end

  test "IDENTIFY and RESUME reject a session revoked after HELLO", %{auth: auth, key: key} do
    assert {:push, _, state} = SocketHandler.init(auth)
    Redix.command(:redix, ["DEL", key])

    for op <- [2, 6] do
      assert {:stop, _, _, _} =
               SocketHandler.handle_in({Jason.encode!(%{op: op, d: %{}}), [opcode: :text]}, state)
    end

    SocketHandler.terminate(:normal, state)
  end

  test "a replacement login cannot validate the previous session generation", %{
    auth: auth,
    key: key
  } do
    assert :ok = SocketAuth.check_session_liveness(auth)

    Redix.command(:redix, [
      "SET",
      key,
      Jason.encode!(%{userId: auth.user_id, deviceId: "device", sessionId: "session-b"})
    ])

    assert {:error, :session_revoked} = SocketAuth.check_session_liveness(auth)
  end

  defp upgrade(auth, overrides \\ %{}) do
    claims =
      Map.merge(
        %{
          "id" => auth.user_id,
          "device_id" => auth.device_id,
          "sid" => auth.session_generation,
          "exp" => auth.token_exp,
          "type" => "access"
        },
        overrides
      )

    key = JOSE.JWK.from_oct(Application.fetch_env!(:void_gateway, :access_secret))
    {_, token} = JOSE.JWT.sign(key, %{"alg" => "HS256"}, claims) |> JOSE.JWS.compact()

    conn =
      Plug.Test.conn("GET", "/gateway")
      |> Plug.Conn.put_req_header("cookie", "accessToken=" <> token)

    SocketAuth.verify_upgrade(conn)
  end

  test "an old signed JWT cannot adopt the current cache generation on a new upgrade", %{
    auth: auth,
    key: key
  } do
    assert {:ok, ^auth} = upgrade(auth)

    Redix.command(:redix, [
      "SET",
      key,
      Jason.encode!(%{userId: auth.user_id, deviceId: auth.device_id, sessionId: "replacement"})
    ])

    assert {:error, _} = upgrade(auth)
    assert {:ok, new_auth} = upgrade(auth, %{"sid" => "replacement"})
    assert new_auth.session_generation == "replacement"
  end

  test "legacy, refresh-type and expired JWTs cannot authenticate", %{auth: auth} do
    assert {:error, _} = upgrade(auth, %{"sid" => nil})
    assert {:error, _} = upgrade(auth, %{"sid" => ""})
    assert {:error, _} = upgrade(auth, %{"type" => "refresh"})
    assert {:error, _} = upgrade(auth, %{"exp" => System.system_time(:second) - 1})
  end

  test "identified sockets stop before receiving events or heartbeats after revocation", %{
    auth: auth,
    key: key
  } do
    assert {:push, _, state} = SocketHandler.init(auth)
    identified = %{state | status: :identified}

    assert {:push, {:text, frame}, _} =
             SocketHandler.handle_info({:push_event, "MESSAGE_CREATE", %{}}, identified)

    assert Jason.decode!(frame)["t"] == "MESSAGE_CREATE"
    Redix.command(:redix, ["DEL", key])

    assert {:stop, _, {4001, _}, _} =
             SocketHandler.handle_info({:push_event, "MESSAGE_CREATE", %{}}, identified)

    assert {:stop, _, {4001, _}, _} =
             SocketHandler.handle_in({Jason.encode!(%{op: 1}), [opcode: :text]}, identified)

    for event <- [
          {:token_expiring_warning, 30},
          {:presence_mode_updated, "idle"},
          {:shutdown_event, 100}
        ] do
      assert {:stop, _, {4001, _}, _} = SocketHandler.handle_info(event, identified)
    end

    SocketHandler.terminate(:normal, state)
  end

  test "a revocation marker fences even a reappearing cache entry", %{auth: auth} do
    marker = "auth:revoked-session:#{auth.session_generation}"
    Redix.command(:redix, ["SET", marker, "1"])
    on_exit(fn -> Redix.command(:redix, ["DEL", marker]) end)
    assert {:error, _} = upgrade(auth)
    assert {:error, _} = SocketAuth.check_session_liveness(auth)
  end

  test "delayed disconnect and token-expiry commands cannot affect a replacement", %{auth: auth} do
    assert {:push, _, state} = SocketHandler.init(auth)

    assert {:ok, ^state} =
             SocketHandler.handle_info({:disconnect, 4001, "old", "old-generation"}, state)

    assert {:ok, ^state} =
             SocketHandler.handle_info(
               {:update_token_expiry, auth.token_exp + 300, "old-generation"},
               state
             )

    assert {:stop, _, _, _} =
             SocketHandler.handle_info(
               {:disconnect, 4001, "revoked", auth.session_generation},
               state
             )

    SocketHandler.terminate(:normal, state)
  end

  test "pubsub disconnect closes sockets rather than silently losing revocations", %{auth: auth} do
    assert :ok = ConnectionRegistry.register_pending(auth.user_id, auth.device_id, self())

    assert {:noreply, %{}} =
             VoidGateway.GatewaySubscriber.handle_info(
               {:redix_pubsub, nil, nil, :disconnected, %{}},
               %{}
             )

    assert_receive {:disconnect, 4001, "Session verification unavailable"}
    ConnectionRegistry.unregister(auth.user_id, auth.device_id, self())
  end

  test "real pubsub invalidation reaches an identified generation", %{auth: auth} do
    assert {:push, _, state} = SocketHandler.init(auth)

    command =
      Jason.encode!(%{
        type: "command",
        command: "disconnectSession",
        data: %{
          userId: auth.user_id,
          deviceId: auth.device_id,
          sessionId: auth.session_generation
        }
      })

    {:ok, count} = Redix.command(:redix, ["PUBLISH", "void:gateway", command])
    assert count > 0
    assert_receive {:disconnect, 4001, "Session revoked", generation}, 1_000
    assert generation == auth.session_generation

    assert {:stop, _, _, _} =
             SocketHandler.handle_info({:disconnect, 4001, "Session revoked", generation}, state)

    SocketHandler.terminate(:normal, state)
  end
end
