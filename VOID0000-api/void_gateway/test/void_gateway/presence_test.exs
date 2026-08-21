defmodule VoidGateway.PresenceTest do
  use ExUnit.Case, async: true

  alias VoidGateway.Presence

  test "online follows activity while explicit modes override it" do
    assert Presence.effective_status("online", 2, "online") == "online"
    assert Presence.effective_status("idle", 2, "online") == "idle"
    assert Presence.effective_status("online", 2, "idle") == "idle"
    assert Presence.effective_status("online", 2, "dnd") == "dnd"
    assert Presence.effective_status("online", 2, "invisible") == "offline"
  end

  test "no live sockets always means offline" do
    for mode <- ["online", "idle", "dnd", "invisible"] do
      assert Presence.effective_status("online", 0, mode) == "offline"
    end
  end

  test "invalid and historical modes normalize to online" do
    assert Presence.valid_mode?("dnd")
    refute Presence.valid_mode?("offline")
    assert Presence.normalize_mode("invisible") == "invisible"
    assert Presence.normalize_mode("auto") == "online"
    assert Presence.normalize_mode("unknown") == "online"
  end
end
