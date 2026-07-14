import LegalLayout, {
  LegalBulletList,
  LegalSection,
} from '../components/common/LegalLayout';

const LAST_UPDATED = 'July 6, 2026';

export default function PrivacyPolicy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      subtitle="This page explains what data VOID uses, why it uses it, and how it is stored."
      lastUpdated={LAST_UPDATED}
      active="privacy"
    >
      <LegalSection title="1. What VOID Collects">
        <LegalBulletList
          items={[
            'basic account and profile data such as username, email address, password hash, display name, bio, and uploaded profile or group images',
            'security and device data such as IP address, user-agent, device identifiers, device fingerprint, session records, and login or abuse-prevention logs',
            'conversation data such as friendships, conversation membership, nicknames, invites, join requests, message metadata, and attachments',
            'two-factor authentication data if you use that feature',
            'local browser data such as settings, cached account data, and queued sends',
          ]}
        />
      </LegalSection>

      <LegalSection title="2. How VOID Uses Data">
        <LegalBulletList
          items={[
            'to create accounts, verify email, reset passwords, and keep users signed in',
            'to deliver direct messages, group chats, invites, media, and notifications',
            'to keep conversations and account settings in sync across sessions',
            'to detect abuse, spam, suspicious activity, and service misuse',
            'to operate, secure, debug, and improve the service',
          ]}
        />
      </LegalSection>

      <LegalSection title="3. Message Privacy">
        <p>
          Messages and attachments are processed and stored by VOID so they can be delivered,
          synchronized, moderated, and recovered as part of the service.
        </p>
        <p>
          Use the service with that expectation and avoid sharing information you do not want
          stored by the service.
        </p>
      </LegalSection>

      <LegalSection title="4. Storage And Sharing">
        <p>
          VOID stores data in its app databases, object storage, session systems, email flow, and
          your own browser storage as needed to run the service.
        </p>
        <LegalBulletList
          items={[
            'other users may see data when the feature requires it, such as usernames, display names, avatars, group icons, and invite previews',
            'basic infrastructure or service providers may process the limited data needed to host, store, secure, and deliver the service',
            'data may also be used when required for legal compliance, abuse response, or protection of the service and its users',
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Retention And Controls">
        <p>
          VOID keeps data for as long as it is needed to run the service, secure accounts, support
          recovery, enforce rules, and maintain operational records.
        </p>
        <LegalBulletList
          items={[
            'You can edit some profile and settings data inside the app.',
            'You can leave conversations, remove friends, or stop using the service at any time.',
            'VOID does not currently provide a built-in full data export flow or guaranteed immediate deletion of all stored records.',
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Changes">
        <p>
          This Privacy Policy may be updated over time. When it changes, the last updated date on
          this page will change too.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
