import { useEffect } from 'react';
import { useUser } from '../../Services/Auth/UserContext';
import { queuedSendRecovery } from '../../Services/Chat/queuedSendRecovery';

const QueuedSendRecoveryAgent = () => {
  const { user } = useUser();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) {
      queuedSendRecovery.stop();
      return;
    }

    queuedSendRecovery.start(userId);
    return () => queuedSendRecovery.stop(userId);
  }, [userId]);

  return null;
};

export default QueuedSendRecoveryAgent;
