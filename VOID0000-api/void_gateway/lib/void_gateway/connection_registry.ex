defmodule VoidGateway.ConnectionRegistry do
  @moduledoc """
  ETS-backed registry mapping {userId, deviceId, pid} to socket metadata.

  Key design decisions vs the first version ({userId, deviceId} -> pid):

    - The ETS key is a 3-tuple {userId, deviceId, pid} instead of a 2-tuple.
      This allows multiple live sockets per {userId, deviceId}, matching the
      Node gateway which uses userId -> Set<WebSocket> and supports up to 5
      concurrent connections per user across any device combination.

    - unregister/3 takes an explicit pid and only removes that one row.
      A second socket for the same {userId, deviceId} no longer overwrites the
      first entry on register, and the first socket terminating no longer
      deletes the second socket's entry.

    - The GenServer monitors every registered pid. If a socket process crashes
      before its terminate/2 callback fires (abnormal exit, VM fault), the
      {:DOWN} message cleans up the stale ETS entry. WebSock's terminate/2
      should always run, but the monitor closes the gap for free.

    - Same-tab dedupe: register/5 is a synchronous GenServer.call so the
      find-displaced + insert + monitor sequence is atomic. Two simultaneous
      IDENTIFY/RESUME calls for the same {userId, deviceId, clientInstanceId}
      are serialized — the second one always sees the first's entry and
      returns it as displaced. This is only on IDENTIFY/RESUME, not on the
      event-push hot path, so the serialization cost is negligible.

    - Presence is tracked per socket. A user is online when any registered
      socket is online, idle when every registered socket is idle, and offline
      only when no sockets remain.
  """

  use GenServer

  @table :gateway_connections
  @active_presence_statuses ["online", "idle"]

  # ---------------------------------------------------------------------------
  # Client API
  # ---------------------------------------------------------------------------

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @doc """
  Register a socket and return any displaced pids.

  Runs as a synchronous GenServer.call so that find-displaced + insert +
  monitor is atomic — no race between concurrent IDENTIFY/RESUME calls.

  Displaced = existing sockets for the same {userId, deviceId} whose
  clientInstanceId matches the new one. When clientInstanceId is nil,
  no dedupe occurs (client didn't provide one, so identity is unknown).
  """
  @spec register(String.t(), String.t(), String.t() | nil, pid(), String.t()) :: [pid()]
  def register(user_id, device_id, client_instance_id, pid, presence_status \\ "online")
      when is_binary(user_id) and is_binary(device_id) and is_pid(pid) and
             presence_status in @active_presence_statuses do
    GenServer.call(
      __MODULE__,
      {:register, user_id, device_id, client_instance_id, pid, presence_status}
    )
  end

  # Removes exactly the row for this {userId, deviceId, pid}.
  # All other pids for the same {userId, deviceId} are unaffected.
  # Called from the socket process in terminate/2 — safe to do directly
  # in the calling process since it only touches its own row.
  @spec unregister(String.t(), String.t(), pid()) :: :ok
  def unregister(user_id, device_id, pid)
      when is_binary(user_id) and is_binary(device_id) and is_pid(pid) do
    :ets.delete(@table, {user_id, device_id, pid})
    :ok
  end

  @doc "Update the activity status reported by one registered socket."
  @spec update_presence_status(String.t(), String.t(), pid(), String.t()) ::
          :ok | {:error, :not_found}
  def update_presence_status(user_id, device_id, pid, presence_status)
      when is_binary(user_id) and is_binary(device_id) and is_pid(pid) and
             presence_status in @active_presence_statuses do
    key = {user_id, device_id, pid}

    case :ets.lookup(@table, key) do
      [{^key, metadata}] ->
        :ets.insert(@table, {key, %{metadata | presence_status: presence_status}})
        :ok

      [] ->
        {:error, :not_found}
    end
  end

  @doc "Return the aggregate availability and active socket count for a user."
  @spec presence_summary(String.t()) :: %{
          status: String.t(),
          active_count: non_neg_integer()
        }
  def presence_summary(user_id) do
    statuses =
      :ets.match_object(@table, {{user_id, :_, :_}, :_})
      |> Enum.map(fn {_key, metadata} -> metadata.presence_status end)

    status =
      cond do
        statuses == [] -> "offline"
        "online" in statuses -> "online"
        true -> "idle"
      end

    %{status: status, active_count: length(statuses)}
  end

  # All pids currently registered for a specific {userId, deviceId} pair.
  # ETS read in the calling process — no GenServer round-trip on the hot path.
  @spec lookup(String.t(), String.t()) :: [pid()]
  def lookup(user_id, device_id) do
    :ets.match_object(@table, {{user_id, device_id, :_}, :_})
    |> Enum.map(fn {{_uid, _did, pid}, _} -> pid end)
  end

  # Total number of registered sockets across all users.
  # Used by /health and telemetry — cheap O(1) ETS metadata read.
  @spec count() :: non_neg_integer()
  def count, do: :ets.info(@table, :size)

  # All registered socket pids. Used by Drain to broadcast SHUTDOWN.
  # Not on the hot path — only called once during graceful shutdown.
  @spec all_pids() :: [pid()]
  def all_pids do
    :ets.match(@table, {{:_, :_, :"$1"}, :_})
    |> Enum.map(fn [pid] -> pid end)
  end

  # All {deviceId, pid} pairs for every socket belonging to a user.
  # Used by EventDispatcher to fan out a pub/sub event to all of a user's
  # connected sockets regardless of device.
  # ETS read in the calling process — no GenServer round-trip on the hot path.
  @spec lookup_all_for_user(String.t()) :: [{String.t(), pid()}]
  def lookup_all_for_user(user_id) do
    :ets.match_object(@table, {{user_id, :_, :_}, :_})
    |> Enum.map(fn {{_uid, device_id, pid}, _} -> {device_id, pid} end)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    {:ok, %{monitors: %{}}}
  end

  # Atomic register-and-displace. All three steps (find displaced, insert,
  # monitor) happen inside the GenServer so concurrent callers are serialized.
  @impl true
  def handle_call(
        {:register, user_id, device_id, client_instance_id, pid, presence_status},
        _from,
        %{monitors: monitors} = state
      ) do
    displaced = find_displaced(user_id, device_id, client_instance_id, pid)

    # Remove replaced same-tab sockets immediately so aggregate counts and
    # presence do not briefly include both the old and new connection.
    Enum.each(displaced, fn displaced_pid ->
      :ets.delete(@table, {user_id, device_id, displaced_pid})
    end)

    metadata = %{
      client_instance_id: client_instance_id,
      presence_status: presence_status
    }

    :ets.insert(@table, {{user_id, device_id, pid}, metadata})

    ref = Process.monitor(pid)
    new_monitors = Map.put(monitors, ref, {user_id, device_id, pid})

    {:reply, displaced, %{state | monitors: new_monitors}}
  end

  # Socket process exited — remove its ETS row.
  # This fires even for normal exits, so it duplicates the unregister/3 call
  # from terminate/2. :ets.delete on a missing key is a safe no-op.
  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{monitors: monitors} = state) do
    case Map.pop(monitors, ref) do
      {{user_id, device_id, pid}, new_monitors} ->
        :ets.delete(@table, {user_id, device_id, pid})
        {:noreply, %{state | monitors: new_monitors}}

      {nil, _} ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---------------------------------------------------------------------------
  # Same-tab dedupe (private, called inside GenServer)
  # ---------------------------------------------------------------------------

  # Returns pids of existing sockets for the same {userId, deviceId} whose
  # clientInstanceId matches, excluding the new pid itself.
  # When client_instance_id is nil, returns [] (no dedupe possible).
  defp find_displaced(_user_id, _device_id, nil, _new_pid), do: []

  defp find_displaced(user_id, device_id, client_instance_id, new_pid) do
    :ets.match_object(@table, {{user_id, device_id, :_}, :_})
    |> Enum.filter(fn {{_uid, _did, pid}, metadata} ->
      pid != new_pid and metadata.client_instance_id == client_instance_id
    end)
    |> Enum.map(fn {{_uid, _did, pid}, _} -> pid end)
  end
end
