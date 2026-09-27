import { Page } from '../components/common';
import { ProfilesPanel } from '../components/terminal/ProfilesPanel';

/**
 * Profiles got its own page in the Settings & Legal sidebar (2026-09-26, user:
 * "profiles should have its own section on the left side of settings"). It
 * was the fourth section of the long Settings page, where it read as one more
 * preference rather than what it is: which copy of the app this window is.
 */
export function ProfilesPage() {
  return (
    <Page
      title="Profiles"
      subtitle="Separate copies of the app on this computer, like browser profiles: each has its own settings, wallets, scripts and history, and several can run at once, side by side."
    >
      <ProfilesPanel />
    </Page>
  );
}
