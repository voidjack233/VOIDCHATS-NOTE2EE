import { useState } from 'react';
import { ChevronRight, LogOut, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../../../Services/Auth/UserContext';
import { useAccountSettings } from '../../../Services/hooks/Settings/useAccount';
import ActiveSessionsModal from './ActiveSessions/ActiveSessionsModal';
import ChangePasswordModal from './ChangePassword/ChangePasswordModal';
import TwoFactorSettingsModal from './2FA/TwoFactorModal';

const AccountTab = () => {
  const navigate = useNavigate();
  const { logout } = useUser();
  const { account, loading } = useAccountSettings();
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showActiveSessions, setShowActiveSessions] = useState(false);
  const [showTwoFactor, setShowTwoFactor] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      navigate('/auth', { replace: true });
    } catch (error) {
      console.error('Logout failed', error);
      setIsLoggingOut(false);
    }
  };

  const securityActions = [
    {
      title: 'Change Password',
      description: 'Update your account password',
      onClick: () => setShowChangePassword(true),
    },
    {
      title: 'Two-Factor Authentication',
      description: 'Manage your 2FA settings',
      onClick: () => setShowTwoFactor(true),
    },
    {
      title: 'Active Sessions',
      description: 'Manage your signed-in devices',
      onClick: () => setShowActiveSessions(true),
    },
  ];

  return (
    <>
      <div className="space-y-4 pb-6 md:space-y-6">
        <div>
          <h4 className="mb-3 text-xs font-semibold uppercase text-void-text-muted md:text-sm">
            Account Information
          </h4>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-void-text">Email Address</label>
              <div className="w-full truncate rounded-lg border border-void-border bg-gray-900 px-4 py-3 text-sm text-void-text">
                {loading ? 'Loading...' : account?.email || 'Not available'}
              </div>
              <p className="mt-1 text-xs text-void-text-muted">Email cannot be changed</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-void-text">Username</label>
              <div className="w-full rounded-lg border border-void-border bg-gray-900 px-4 py-3 text-sm text-void-text">
                {loading ? 'Loading...' : account?.username || 'Not available'}
              </div>
              <p className="mt-1 text-xs text-void-text-muted">Username cannot be changed</p>
            </div>
          </div>
        </div>

        <div className="border-t border-void-border pt-4">
          <h4 className="mb-3 text-xs font-semibold uppercase text-void-text-muted md:text-sm">Security</h4>
          <div className="space-y-2">
            {securityActions.map((action) => (
              <button
                key={action.title}
                onClick={action.onClick}
                className="w-full rounded-lg border border-void-border bg-gray-900 px-3 py-2.5 transition-all hover:border-blue-500 hover:bg-gray-900/70 active:scale-[0.98] md:px-4 md:py-3"
              >
                <div className="flex items-center justify-between">
                  <div className="text-left">
                    <p className="text-sm font-medium text-void-text">{action.title}</p>
                    <p className="mt-0.5 hidden text-xs text-void-text-muted sm:block">{action.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Shield className="hidden h-4 w-4 text-void-text-muted sm:block" />
                    <ChevronRight className="h-4 w-4 text-void-text-muted" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-void-border pt-4">
          <button
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="w-full rounded-lg border border-void-border bg-gray-900 px-3 py-2.5 transition-all hover:border-orange-500 hover:bg-gray-900/70 active:scale-[0.98] disabled:opacity-50 md:px-4 md:py-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <LogOut className="h-4 w-4 text-orange-400" />
                <div className="text-left">
                  <p className="text-sm font-medium text-orange-400">
                    {isLoggingOut ? 'Logging out...' : 'Log Out'}
                  </p>
                  <p className="mt-0.5 hidden text-xs text-void-text-muted sm:block">Sign out of your account</p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-orange-400" />
            </div>
          </button>
        </div>

        <div className="border-t border-void-border pt-4">
          <h4 className="mb-3 text-xs font-semibold uppercase text-red-400 md:text-sm">Danger Zone</h4>
          <button disabled className="w-full cursor-not-allowed rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2.5 opacity-70 md:px-4 md:py-3">
            <div className="flex items-center justify-between">
              <div className="text-left">
                <p className="text-sm font-medium text-red-400">Delete Account</p>
                <p className="mt-0.5 hidden text-xs text-red-300/70 sm:block">Account deletion is not available in this app.</p>
              </div>
              <span className="rounded-full border border-red-800/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-300/80">Unavailable</span>
            </div>
          </button>
        </div>
      </div>

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      {showActiveSessions && <ActiveSessionsModal onClose={() => setShowActiveSessions(false)} />}
      {showTwoFactor && <TwoFactorSettingsModal onClose={() => setShowTwoFactor(false)} />}
    </>
  );
};

export default AccountTab;
