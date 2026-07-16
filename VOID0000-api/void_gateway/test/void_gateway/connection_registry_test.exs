defmodule VoidGateway.ConnectionRegistryTest do
  use ExUnit.Case, async: false

  alias VoidGateway.ConnectionRegistry

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

  defp socket_process do
    pid = spawn(fn -> Process.sleep(:infinity) end)
    on_exit(fn -> Process.exit(pid, :kill) end)
    pid
  end
end
