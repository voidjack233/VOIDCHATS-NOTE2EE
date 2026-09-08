defmodule VoidGateway.ConnectionRegistryTest do
  use ExUnit.Case, async: false

  alias VoidGateway.ConnectionRegistry
  alias VoidGateway.EventDispatcher

  test "pending sockets count toward admission and receive revocation, but not presence" do
    user = "pending-#{System.unique_integer([:positive])}"
    assert :ok = ConnectionRegistry.register_pending(user, "device", self())
    assert ConnectionRegistry.presence_summary(user) == %{status: "offline", active_count: 0}
    assert self() in ConnectionRegistry.lookup(user, "device")

    assert :ok =
             EventDispatcher.dispatch(%{
               "type" => "command",
               "command" => "disconnectSession",
               "data" => %{
                 "userId" => user,
                 "deviceId" => "device",
                 "code" => 4001,
                 "reason" => "revoked"
               }
             })

    assert_receive {:disconnect, 4001, "revoked"}
    ConnectionRegistry.unregister(user, "device", self())
  end

  test "pending connection admission is atomic and bounded per account" do
    user = "bounded-#{System.unique_integer([:positive])}"
    sockets = for _ <- 1..12, do: socket_process()

    results =
      Enum.map(sockets, fn pid -> ConnectionRegistry.register_pending(user, "device", pid) end)

    assert Enum.count(results, &(&1 == :ok)) == 8
    assert length(ConnectionRegistry.lookup_all_for_user(user)) == 8
    Enum.each(sockets, fn pid -> ConnectionRegistry.unregister(user, "device", pid) end)
    assert :ok = ConnectionRegistry.register_pending(user, "device", self())
    ConnectionRegistry.unregister(user, "device", self())
  end

  test "aggregates activity across every socket for a user" do
    user_id = "presence-user"
    online_socket = socket_process()
    idle_socket = socket_process()

    ConnectionRegistry.register(user_id, "device-a", "tab-a", online_socket, "online")
    ConnectionRegistry.register(user_id, "device-b", "tab-b", idle_socket, "idle")

    assert ConnectionRegistry.presence_summary(user_id) == %{
             status: "online",
             active_count: 2
           }

    assert :ok =
             ConnectionRegistry.update_presence_status(
               user_id,
               "device-a",
               online_socket,
               "idle"
             )

    assert ConnectionRegistry.presence_summary(user_id) == %{
             status: "idle",
             active_count: 2
           }

    ConnectionRegistry.unregister(user_id, "device-a", online_socket)
    ConnectionRegistry.unregister(user_id, "device-b", idle_socket)

    assert ConnectionRegistry.presence_summary(user_id) == %{
             status: "offline",
             active_count: 0
           }
  end

  test "same-tab replacement immediately removes the displaced socket" do
    user_id = "replacement-user"
    old_socket = socket_process()
    new_socket = socket_process()

    assert [] =
             ConnectionRegistry.register(
               user_id,
               "device-a",
               "same-tab",
               old_socket,
               "idle"
             )

    assert [^old_socket] =
             ConnectionRegistry.register(
               user_id,
               "device-a",
               "same-tab",
               new_socket,
               "online"
             )

    assert ConnectionRegistry.lookup(user_id, "device-a") == [new_socket]

    assert ConnectionRegistry.presence_summary(user_id) == %{
             status: "online",
             active_count: 1
           }
  end

  test "presence mode commands reach every live socket without changing activity" do
    user_id = "presence-mode-user"

    ConnectionRegistry.register(user_id, "device-a", "tab-a", self(), "online")

    second_socket = forwarding_socket(self())
    ConnectionRegistry.register(user_id, "device-b", "tab-b", second_socket, "idle")

    assert :ok =
             EventDispatcher.dispatch(%{
               "type" => "command",
               "command" => "updatePresenceMode",
               "data" => %{"userId" => user_id, "mode" => "dnd"}
             })

    assert_receive {:presence_mode_updated, "dnd"}
    assert_receive {:forwarded, {:presence_mode_updated, "dnd"}}

    assert ConnectionRegistry.presence_summary(user_id) == %{
             status: "online",
             active_count: 2
           }

    ConnectionRegistry.unregister(user_id, "device-a", self())
    ConnectionRegistry.unregister(user_id, "device-b", second_socket)
  end

  defp socket_process do
    pid = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(pid, :kill) end)
    pid
  end

  defp forwarding_socket(parent) do
    pid = spawn(fn -> forwarding_loop(parent) end)
    on_exit(fn -> Process.exit(pid, :kill) end)
    pid
  end

  defp forwarding_loop(parent) do
    receive do
      message ->
        send(parent, {:forwarded, message})
        forwarding_loop(parent)
    end
  end
end
