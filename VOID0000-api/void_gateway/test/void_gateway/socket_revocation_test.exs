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
      session_generation: 1234
    }

    {:ok, "OK"} =
      Redix.command(:redix, [
        "SET",
        key,
        Jason.encode!(%{userId: user, deviceId: "device", createdAt: 1234})
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
      Jason.encode!(%{userId: auth.user_id, deviceId: "device", createdAt: 5678})
    ])

    assert {:error, :session_revoked} = SocketAuth.check_session_liveness(auth)
  end
end
