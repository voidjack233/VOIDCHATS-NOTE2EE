defmodule VoidGateway.ConnectionRegistryTest do
  use ExUnit.Case, async: false

  alias VoidGateway.ConnectionRegistry
  alias VoidGateway.EventDispatcher

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
