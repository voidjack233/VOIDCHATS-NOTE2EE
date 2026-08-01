import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import {
  Camera,
  Check,
  Copy,
  Crown,
  ImageOff,
  Link2,
  LogOut,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Save,
  Shield,
  ShieldAlert,
  Trash2,
  UserMinus,
  UserRoundCog,
  Users,
  X,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppHeader } from '../../components/common/AppHeader';
import { Avatar } from '../../components/common/Avatar';
import { Button } from '../../components/common/Button';
import { FeedbackBanner } from '../../components/common/FeedbackBanner';
import { Screen } from '../../components/common/Screen';
import { StateView } from '../../components/common/StateView';
import { TextField } from '../../components/common/TextField';
import {
  ActionRow,
  BottomSheet,
  MenuRow,
  RoleBadge,
  SectionCard,
  SwitchRow,
  WhoChoice,
} from '../../components/group/GroupSettingsPrimitives';
import { useAppData } from '../../context/AppDataContext';
import { useAuth } from '../../context/AuthContext';
import type { RootStackParamList } from '../../navigation/types';
import { chatService } from '../../services/chat';
import { useTheme } from '../../theme/ThemeContext';
import type {
  Conversation,
  ConversationInviteLink,
  ConversationJoinRequest,
  ConversationMember,
  GroupPermissions,
} from '../../types/models';

type Props = NativeStackScreenProps<RootStackParamList, 'GroupSettings'>;
type SectionKey = 'profile' | 'members' | 'invites' | 'permissions';
type Notice = { message: string; kind: 'error' | 'success' | 'info' };

const MAX_ICON_BYTES = 7 * 1024 * 1024;
const roleRank: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

const meetsWhoThreshold = (role: string, threshold: 'everyone' | 'admins' | 'owner') => {
  if (role === 'owner') return true;
  if (threshold === 'everyone') return role !== 'viewer';
  if (threshold === 'admins') return role === 'admin';
  return false;
};

const memberLabel = (member: ConversationMember) =>
  member.nickname || member.display_name || member.username;

const accountLabel = (member: ConversationMember) => member.display_name || member.username;

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatRequestDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const inviteState = (invite: ConversationInviteLink) => {
  if (invite.is_revoked) return 'Revoked';
  if (invite.expires_at && Date.parse(invite.expires_at) <= Date.now()) return 'Expired';
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) return 'Exhausted';
  return 'Active';
};

const sectionTitles: Record<SectionKey, string> = {
  profile: 'Profile',
  members: 'Members',
  invites: 'Invites',
  permissions: 'Permissions',
};

export function GroupSettingsScreen({ navigation, route }: Props) {
  const { palette } = useTheme();
  const { user } = useAuth();
  const { patchConversation, removeConversation } = useAppData();
  const conversationId = route.params.conversation.public_id || route.params.conversation.id;

  const [section, setSection] = useState<SectionKey | null>(null);
  const [conversation, setConversation] = useState<Conversation>(route.params.conversation);
  const [members, setMembers] = useState<ConversationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const [profileName, setProfileName] = useState(route.params.conversation.name || '');
  const [selectedIcon, setSelectedIcon] = useState<{ uri: string; data: string } | null>(null);
  const [removeIcon, setRemoveIcon] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  const [selectedMember, setSelectedMember] = useState<ConversationMember | null>(null);
  const [roleMember, setRoleMember] = useState<ConversationMember | null>(null);
  const [nicknameMember, setNicknameMember] = useState<ConversationMember | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [busyMemberAction, setBusyMemberAction] = useState('');

  const [invites, setInvites] = useState<ConversationInviteLink[]>([]);
  const [requests, setRequests] = useState<ConversationJoinRequest[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesLoaded, setInvitesLoaded] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [busyInviteId, setBusyInviteId] = useState<number | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<number | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);
  const [hideExpired, setHideExpired] = useState(true);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [permissions, setPermissions] = useState<GroupPermissions | null>(
    route.params.conversation.permissions || null,
  );
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [permissionsError, setPermissionsError] = useState('');
  const permissionsAttempted = useRef(false);
  const permissionsReady = useRef(false);
  const lastSavedPermissions = useRef('');
  const permissionSaveVersion = useRef(0);

  const currentMember = members.find((member) => member.user_id === user?.id);
  const isOwner = conversation.owner_id === user?.id || currentMember?.role === 'owner';
  const currentRole = isOwner ? 'owner' : currentMember?.role || conversation.role;
  const effectivePermissions = permissions || conversation.permissions;
  const groupProfileThreshold = effectivePermissions?.who_can_edit_group_profile || 'admins';
  const canManageProfile = isOwner ||
    (groupProfileThreshold === 'admins' && currentRole === 'admin') ||
    (groupProfileThreshold === 'everyone' && currentRole !== 'viewer');
  const canManageInvites = isOwner || (
    currentRole === 'admin' && (effectivePermissions?.admin_can_manage_invite_links ?? true)
  );
  const canChangeMemberRoles = isOwner || currentRole === 'admin';
  const canKickMembers = isOwner || (
    currentRole === 'admin' && (effectivePermissions?.admin_can_remove_members ?? true)
  );
  const isSoloOwner = isOwner && members.length <= 1;
  const canLeaveGroup = !isOwner || isSoloOwner;

  const sortedMembers = useMemo(() => [...members].sort((left, right) => {
    const rank = (roleRank[left.role] ?? 4) - (roleRank[right.role] ?? 4);
    return rank || memberLabel(left).localeCompare(memberLabel(right));
  }), [members]);

  const loadDetail = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setLoadError('');
    try {
      const detail = await chatService.conversation(conversationId);
      setConversation(detail.conversation);
      setMembers(detail.conversation.members || []);
      if (initial) setProfileName(detail.conversation.name || '');
      patchConversation(detail.conversation);
      return detail;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to load group settings';
      setLoadError(message);
      if (!initial) setNotice({ message, kind: 'error' });
      return null;
    } finally {
      if (initial) setLoading(false);
    }
  }, [conversationId, patchConversation]);

  useEffect(() => {
    void loadDetail(true);
  }, [loadDetail]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const loadPermissions = useCallback(async () => {
    setPermissionsLoading(true);
    setPermissionsError('');
    try {
      const result = await chatService.permissions(conversationId);
      const signature = JSON.stringify(result);
      lastSavedPermissions.current = signature;
      permissionsReady.current = true;
      setPermissions(result);
      setConversation((current) => ({ ...current, permissions: result }));
    } catch (caught) {
      permissionsReady.current = false;
      setPermissionsError(caught instanceof Error ? caught.message : 'Failed to load permissions');
    } finally {
      setPermissionsLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!currentRole || permissionsAttempted.current) return;
    permissionsAttempted.current = true;
    void loadPermissions();
  }, [currentRole, loadPermissions]);

  useEffect(() => {
    if (!isOwner || !permissions || !permissionsReady.current) return;
    const signature = JSON.stringify(permissions);
    if (signature === lastSavedPermissions.current) return;
    const version = ++permissionSaveVersion.current;
    const timer = setTimeout(() => {
      setPermissionsSaving(true);
      setPermissionsError('');
      void chatService.updatePermissions(conversationId, permissions)
        .then((result) => {
          if (version !== permissionSaveVersion.current) return;
          lastSavedPermissions.current = JSON.stringify(result);
          setPermissions(result);
          setConversation((current) => ({ ...current, permissions: result }));
        })
        .catch((caught: unknown) => {
          if (version !== permissionSaveVersion.current) return;
          setPermissionsError(caught instanceof Error ? caught.message : 'Failed to save permissions');
        })
        .finally(() => {
          if (version === permissionSaveVersion.current) setPermissionsSaving(false);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [conversationId, isOwner, permissions]);

  const updatePermission = <K extends keyof GroupPermissions>(key: K, value: GroupPermissions[K]) => {
    setPermissions((current) => current ? { ...current, [key]: value } : current);
  };

  const chooseIcon = async () => {
    setNotice(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        aspect: [1, 1],
        base64: true,
        mediaTypes: ['images'],
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (asset.fileSize && asset.fileSize > MAX_ICON_BYTES) {
        setNotice({ message: 'Group icons must be 7MB or smaller.', kind: 'error' });
        return;
      }
      const extension = asset.fileName?.split('.').pop()?.toLowerCase();
      const inferredMime = extension === 'png'
        ? 'image/png'
        : extension === 'gif'
          ? 'image/gif'
          : extension === 'webp'
            ? 'image/webp'
            : 'image/jpeg';
      const mime = asset.mimeType === 'image/jpg' ? 'image/jpeg' : asset.mimeType || inferredMime;
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) {
        setNotice({ message: 'Choose a JPG, PNG, GIF or WebP image.', kind: 'error' });
        return;
      }
      if (!asset.base64) {
        setNotice({ message: 'Could not read that image. Choose another file.', kind: 'error' });
        return;
      }
      if (Math.ceil(asset.base64.length * 0.75) > MAX_ICON_BYTES) {
        setNotice({ message: 'Group icons must be 7MB or smaller.', kind: 'error' });
        return;
      }
      setSelectedIcon({ uri: asset.uri, data: `data:${mime};base64,${asset.base64}` });
      setRemoveIcon(false);
    } catch (caught) {
      setNotice({
        message: caught instanceof Error ? caught.message : 'Failed to choose group icon',
        kind: 'error',
      });
    }
  };

  const requestRemoveIcon = () => {
    Alert.alert(
      'Remove Group Icon',
      'Remove the current group icon? This change is applied when you save.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Icon',
          style: 'destructive',
          onPress: () => {
            setSelectedIcon(null);
            setRemoveIcon(Boolean(conversation.icon_url));
          },
        },
      ],
    );
  };

  const profileDirty = profileName.trim() !== (conversation.name || '') || Boolean(selectedIcon) || removeIcon;

  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) {
      setNotice({ message: 'Group name is required.', kind: 'error' });
      return;
    }
    setProfileSaving(true);
    setNotice(null);
    try {
      let next = conversation;
      if (name !== (conversation.name || '')) {
        const result = await chatService.updateConversation(conversationId, { name });
        next = result.conversation;
      }
      if (removeIcon) {
        const result = await chatService.removeConversationIcon(conversationId);
        next = result.conversation;
      } else if (selectedIcon) {
        const result = await chatService.uploadConversationIcon(conversationId, selectedIcon.data);
        next = result.conversation;
      }
      setConversation(next);
      setProfileName(next.name || name);
      setSelectedIcon(null);
      setRemoveIcon(false);
      patchConversation(next);
      setNotice({ message: 'Group profile updated.', kind: 'success' });
    } catch (caught) {
      setNotice({
        message: caught instanceof Error ? caught.message : 'Failed to update group profile',
        kind: 'error',
      });
    } finally {
      setProfileSaving(false);
    }
  };

  const canTransferTo = (member: ConversationMember) =>
    isOwner && members.length > 1 && member.user_id !== user?.id && member.role !== 'owner';

  const canChangeRoleFor = (member: ConversationMember) => {
    const regularMember = member.role === 'member' || member.role === 'viewer';
    return canChangeMemberRoles && member.user_id !== user?.id && member.role !== 'owner' && (
      isOwner || regularMember
    );
  };

  const canKickMember = (member: ConversationMember) => {
    const regularMember = member.role === 'member' || member.role === 'viewer';
    return canKickMembers && member.user_id !== user?.id && member.role !== 'owner' && (
      isOwner || regularMember
    );
  };

  const canEditNicknameFor = (member: ConversationMember) => {
    const threshold = member.user_id === user?.id
      ? effectivePermissions?.who_can_edit_own_nickname || 'everyone'
      : effectivePermissions?.who_can_edit_other_nicknames || 'admins';
    return meetsWhoThreshold(currentRole, threshold);
  };

  const openNicknameEditor = (member: ConversationMember) => {
    if (!canEditNicknameFor(member)) return;
    setSelectedMember(null);
    setNicknameMember(member);
    setNicknameDraft(member.nickname || '');
  };

  const saveMemberNickname = async () => {
    if (!nicknameMember) return;
    const normalized = nicknameDraft.trim() || null;
    const member = nicknameMember;
    setBusyMemberAction(`nickname:${member.user_id}`);
    setNotice(null);
    try {
      const result = await chatService.updateNickname(conversationId, member.user_id, normalized);
      setMembers((current) => current.map((entry) => entry.user_id === member.user_id
        ? { ...entry, nickname: result.nickname }
        : entry));
      setNicknameMember(null);
      setNicknameDraft('');
      setNotice({ message: normalized ? 'Nickname saved.' : 'Nickname cleared.', kind: 'success' });
    } catch (caught) {
      setNotice({
        message: caught instanceof Error ? caught.message : 'Failed to update nickname',
        kind: 'error',
      });
    } finally {
      setBusyMemberAction('');
    }
  };

  const changeMemberRole = async (role: 'admin' | 'member') => {
    if (!roleMember || roleMember.role === role) return;
    const member = roleMember;
    setBusyMemberAction(`role:${member.user_id}`);
    setNotice(null);
    try {
      await chatService.updateMemberRole(conversationId, member.user_id, role);
      setMembers((current) => current.map((entry) => entry.user_id === member.user_id
        ? { ...entry, role }
        : entry));
      setRoleMember(null);
      setNotice({ message: `${accountLabel(member)} is now ${role === 'admin' ? 'an admin' : 'a member'}.`, kind: 'success' });
    } catch (caught) {
      setNotice({
        message: caught instanceof Error ? caught.message : 'Failed to change member role',
        kind: 'error',
      });
    } finally {
      setBusyMemberAction('');
    }
  };

  const requestTransfer = (member: ConversationMember) => {
    setSelectedMember(null);
    Alert.alert(
      'Transfer Ownership',
      `Transfer ownership to ${accountLabel(member)}? You will become an admin.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Transfer Ownership',
          onPress: () => {
            setBusyMemberAction(`transfer:${member.user_id}`);
            setNotice(null);
            void chatService.transferOwnership(conversationId, member.user_id)
              .then(async (result) => {
                setConversation(result.conversation);
                patchConversation(result.conversation);
                await loadDetail(false);
                setNotice({ message: `Ownership transferred to ${accountLabel(member)}.`, kind: 'success' });
              })
              .catch((caught: unknown) => {
                setNotice({
                  message: caught instanceof Error ? caught.message : 'Failed to transfer ownership',
                  kind: 'error',
                });
              })
              .finally(() => setBusyMemberAction(''));
          },
        },
      ],
    );
  };

  const requestKick = (member: ConversationMember) => {
    setSelectedMember(null);
    Alert.alert(
      'Remove Member',
      `Remove ${accountLabel(member)} from this group?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kick Member',
          style: 'destructive',
          onPress: () => {
            setBusyMemberAction(`kick:${member.user_id}`);
            setNotice(null);
            void chatService.removeMember(conversationId, member.user_id)
              .then(() => {
                setMembers((current) => current.filter((entry) => entry.user_id !== member.user_id));
                setNotice({ message: `${accountLabel(member)} was removed from the group.`, kind: 'success' });
              })
              .catch((caught: unknown) => {
                setNotice({
                  message: caught instanceof Error ? caught.message : 'Failed to remove member',
                  kind: 'error',
                });
              })
              .finally(() => setBusyMemberAction(''));
          },
        },
      ],
    );
  };

  const finishLeaving = () => {
    removeConversation(conversation.id);
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  };

  const requestLeave = () => {
    if (!canLeaveGroup) return;
    const deleting = isSoloOwner;
    Alert.alert(
      deleting ? 'Delete Group' : 'Leave Group',
      deleting
        ? 'You are the only member. Leaving will permanently delete this group.'
        : 'Leave this group? You will lose access to future messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: deleting ? 'Delete and Leave' : 'Leave Group',
          style: 'destructive',
          onPress: () => {
            setBusyMemberAction('leave');
            setNotice(null);
            const action = deleting
              ? chatService.deleteConversation(conversationId)
              : chatService.leaveGroup(conversationId);
            void action
              .then(finishLeaving)
              .catch((caught: unknown) => {
                setNotice({
                  message: caught instanceof Error ? caught.message : 'Failed to leave group',
                  kind: 'error',
                });
              })
              .finally(() => setBusyMemberAction(''));
          },
        },
      ],
    );
  };

  const loadInvites = useCallback(async () => {
    if (!canManageInvites) return;
    setInvitesLoading(true);
    setInviteError('');
    try {
      const result = await chatService.invites(conversationId);
      setInvites(result.invites);
      setRequests(result.requests);
      setInvitesLoaded(true);
    } catch (caught) {
      setInviteError(caught instanceof Error ? caught.message : 'Failed to load invite links');
      setInvitesLoaded(true);
    } finally {
      setInvitesLoading(false);
    }
  }, [canManageInvites, conversationId]);

  useEffect(() => {
    if (section === 'invites' && canManageInvites && !invitesLoaded && !invitesLoading) {
      void loadInvites();
    }
  }, [canManageInvites, invitesLoaded, invitesLoading, loadInvites, section]);

  const createInvite = async () => {
    setCreatingInvite(true);
    setInviteError('');
    try {
      const invite = await chatService.createInvite(conversationId, 7, null);
      setInvites((current) => [invite, ...current.filter((entry) => entry.id !== invite.id)]);
      setNotice({ message: 'Invite link created.', kind: 'success' });
    } catch (caught) {
      setInviteError(caught instanceof Error ? caught.message : 'Failed to create invite link');
    } finally {
      setCreatingInvite(false);
    }
  };

  const copyInvite = async (invite: ConversationInviteLink) => {
    try {
      await Clipboard.setStringAsync(invite.url);
      setCopiedInviteId(invite.id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedInviteId(null), 1800);
    } catch (caught) {
      setInviteError(caught instanceof Error ? caught.message : 'Failed to copy invite link');
    }
  };

  const requestRevokeInvite = (invite: ConversationInviteLink) => {
    Alert.alert(
      'Revoke Invite Link',
      'This link will stop accepting new join requests.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            setBusyInviteId(invite.id);
            setInviteError('');
            void chatService.revokeInvite(conversationId, invite.id)
              .then(() => setInvites((current) => current.map((entry) => entry.id === invite.id
                ? { ...entry, is_revoked: true }
                : entry)))
              .catch((caught: unknown) => {
                setInviteError(caught instanceof Error ? caught.message : 'Failed to revoke invite');
              })
              .finally(() => setBusyInviteId(null));
          },
        },
      ],
    );
  };

  const resolveRequest = async (request: ConversationJoinRequest, action: 'approve' | 'decline') => {
    setBusyRequestId(request.id);
    setInviteError('');
    try {
      if (action === 'approve') {
        await chatService.approveJoinRequest(conversationId, request.id);
      } else {
        await chatService.declineJoinRequest(conversationId, request.id);
      }
      setRequests((current) => current.filter((entry) => entry.id !== request.id));
      if (action === 'approve') void loadDetail(false);
    } catch (caught) {
      setInviteError(caught instanceof Error ? caught.message : `Failed to ${action} join request`);
    } finally {
      setBusyRequestId(null);
    }
  };

  const visibleInvites = invites.filter((invite) => !hideExpired || inviteState(invite) === 'Active');
  const hiddenInviteCount = invites.length - visibleInvites.length;
  const iconUri = removeIcon ? selectedIcon?.uri || null : selectedIcon?.uri || conversation.icon_url;

  const renderMenu = () => (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.groupSummary, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        <Avatar displayName={conversation.name || 'Unnamed Group'} size={66} uri={conversation.icon_url} />
        <View style={styles.summaryCopy}>
          <Text numberOfLines={2} style={[styles.summaryName, { color: palette.text }]}>
            {conversation.name || 'Unnamed Group'}
          </Text>
          <Text style={[styles.summaryMembers, { color: palette.muted }]}>
            {members.length || conversation.member_count} members
          </Text>
        </View>
      </View>

      <Text style={[styles.category, { color: palette.faint }]}>Server</Text>
      <MenuRow
        description="Change the group name and icon shown to members."
        icon={<UserRoundCog color={palette.accent} size={20} />}
        onPress={() => setSection('profile')}
        title="Profile"
      />

      <Text style={[styles.category, { color: palette.faint }]}>People</Text>
      <View style={styles.menuGroup}>
        <MenuRow
          badge={`${members.length || conversation.member_count}`}
          description="Browse everyone currently in this group."
          icon={<Users color={palette.accent} size={20} />}
          onPress={() => setSection('members')}
          title="Members"
        />
        <MenuRow
          badge={canManageInvites ? undefined : 'No access'}
          description="Create invite links and review join requests."
          icon={<Link2 color={palette.accent} size={20} />}
          onPress={() => setSection('invites')}
          title="Invites"
        />
      </View>

      <Text style={[styles.category, { color: palette.faint }]}>Moderation</Text>
      <MenuRow
        badge={isOwner ? undefined : 'Owner only'}
        description="Control what admins and members can do in this group."
        icon={<Shield color={palette.accent} size={20} />}
        onPress={() => setSection('permissions')}
        title="Permissions"
      />
    </ScrollView>
  );

  const renderProfile = () => (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <SectionCard
        description="Change the group name and icon shown to members."
        title="Group Profile"
      >
        <View style={styles.profileContent}>
          <Avatar displayName={profileName || 'Unnamed Group'} size={86} uri={iconUri} />
          <View style={styles.iconActions}>
            <Button compact disabled={!canManageProfile || profileSaving} onPress={() => void chooseIcon()} variant="secondary">
              <Camera color={palette.text} size={15} />
              <Text style={[styles.buttonLabel, { color: palette.text }]}>Upload Icon</Text>
            </Button>
            {(conversation.icon_url || selectedIcon) ? (
              <Button compact disabled={!canManageProfile || profileSaving} onPress={requestRemoveIcon} variant="ghost">
                <ImageOff color={palette.muted} size={15} />
                <Text style={[styles.buttonLabel, { color: palette.muted }]}>Remove Icon</Text>
              </Button>
            ) : null}
          </View>
          <Text style={[styles.helpText, { color: palette.muted }]}>JPG, PNG, GIF or WebP. Max 7MB.</Text>
          <TextField
            editable={canManageProfile && !profileSaving}
            label="Group Name"
            maxLength={100}
            onChangeText={setProfileName}
            placeholder="Unnamed Group"
            value={profileName}
          />
          {!canManageProfile ? (
            <Text style={[styles.helpText, { color: palette.warning }]}>Your role does not have permission to edit the group profile.</Text>
          ) : null}
          <Button
            disabled={!canManageProfile || !profileDirty}
            fullWidth
            loading={profileSaving}
            onPress={() => void saveProfile()}
          >
            <Save color="#ffffff" size={17} />
            <Text style={styles.primaryButtonLabel}>Save Changes</Text>
          </Button>
        </View>
      </SectionCard>
    </ScrollView>
  );

  const renderMembers = () => (
    <ScrollView contentContainerStyle={styles.content}>
      <SectionCard
        description={`${members.length} ${members.length === 1 ? 'person' : 'people'} in this group.`}
        right={<Users color={palette.muted} size={19} />}
        title="Current Members"
      >
        <View style={styles.memberList}>
          {sortedMembers.map((member) => {
            const secondaryName = member.nickname ? accountLabel(member) : null;
            const busy = busyMemberAction.endsWith(`:${member.user_id}`);
            return (
              <View key={member.user_id} style={[styles.memberCard, { borderColor: palette.border }]}>
                <Avatar
                  displayName={member.display_name}
                  size={43}
                  uri={member.avatar_url}
                  username={member.username}
                />
                <View style={styles.memberCopy}>
                  <View style={styles.memberNameLine}>
                    <Text numberOfLines={1} style={[styles.memberName, { color: palette.text }]}>
                      {memberLabel(member)}
                    </Text>
                    <RoleBadge role={member.role} />
                    {member.user_id === user?.id ? (
                      <View style={[styles.youBadge, { backgroundColor: `${palette.accent}20` }]}>
                        <Text style={[styles.youText, { color: palette.accent }]}>You</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text numberOfLines={1} style={[styles.memberMeta, { color: palette.muted }]}>
                    {secondaryName ? `${secondaryName} · ` : ''}@{member.username}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel={`Member actions for ${accountLabel(member)}`}
                  disabled={busy}
                  hitSlop={8}
                  onPress={() => setSelectedMember(member)}
                  style={({ pressed }) => [styles.moreButton, { backgroundColor: pressed ? palette.hover : 'transparent' }]}
                >
                  {busy
                    ? <ActivityIndicator color={palette.muted} size="small" />
                    : <MoreHorizontal color={palette.muted} size={20} />}
                </Pressable>
              </View>
            );
          })}
        </View>
      </SectionCard>

      <SectionCard title="Leaving This Group">
        <View style={styles.leavingContent}>
          <View style={styles.leaveCopyRow}>
            <LogOut color={isOwner && !isSoloOwner ? palette.faint : palette.danger} size={19} />
            <Text style={[styles.leaveDescription, { color: palette.muted }]}>
              {isOwner
                ? isSoloOwner
                  ? 'You are the only member. Leaving will permanently delete this group.'
                  : 'Transfer ownership before leaving this group.'
                : 'Leave this group. You will lose access to future messages.'}
            </Text>
          </View>
          <Button
            disabled={!canLeaveGroup}
            fullWidth
            loading={busyMemberAction === 'leave'}
            onPress={requestLeave}
            variant="danger"
          >
            {isOwner ? (isSoloOwner ? 'Delete Group and Leave' : 'Transfer Ownership First') : 'Leave Group'}
          </Button>
        </View>
      </SectionCard>
    </ScrollView>
  );

  const renderInvites = () => {
    if (!canManageInvites) {
      return (
        <View style={styles.flex}>
          <StateView
            message="Your group role does not have permission to manage invite links or join requests."
            title="Invite access restricted"
            type="empty"
          />
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.content}>
        {inviteError ? <FeedbackBanner message={inviteError} onDismiss={() => setInviteError('')} /> : null}

        <SectionCard title="Invite Links">
          <View style={styles.sectionActions}>
            <Button fullWidth loading={creatingInvite} onPress={() => void createInvite()}>
              <Link2 color="#ffffff" size={17} />
              <Text style={styles.primaryButtonLabel}>Create Invite Link</Text>
            </Button>
          </View>
        </SectionCard>

        <SectionCard
          right={(
            <Button compact disabled={invitesLoading} onPress={() => void loadInvites()} variant="secondary">
              <RefreshCw color={palette.text} size={14} />
              <Text style={[styles.smallButtonLabel, { color: palette.text }]}>Refresh</Text>
            </Button>
          )}
          title="Pending Join Requests"
        >
          {invitesLoading && !invitesLoaded ? (
            <StateView compact title="Loading join requests..." type="loading" />
          ) : requests.length === 0 ? (
            <Text style={[styles.emptyText, { color: palette.muted }]}>No pending requests right now.</Text>
          ) : (
            <View style={styles.requestList}>
              {requests.map((request) => {
                const busy = busyRequestId === request.id;
                return (
                  <View key={request.id} style={[styles.requestCard, { borderColor: palette.border }]}>
                    <View style={styles.requestIdentity}>
                      <Avatar
                        displayName={request.display_name}
                        size={42}
                        uri={request.avatar_url}
                        username={request.username}
                      />
                      <View style={styles.requestCopy}>
                        <Text numberOfLines={1} style={[styles.requestName, { color: palette.text }]}>
                          {request.display_name || request.username}
                        </Text>
                        <Text style={[styles.requestMeta, { color: palette.muted }]}>
                          @{request.username} · Requested {formatRequestDate(request.created_at)}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.requestActions}>
                      <Button compact disabled={busy} onPress={() => void resolveRequest(request, 'decline')} variant="secondary">
                        <X color={palette.text} size={15} />
                        <Text style={[styles.smallButtonLabel, { color: palette.text }]}>Decline</Text>
                      </Button>
                      <Button compact disabled={busy} onPress={() => void resolveRequest(request, 'approve')}>
                        {busy
                          ? <ActivityIndicator color="#ffffff" size="small" />
                          : <Check color="#ffffff" size={15} />}
                        <Text style={styles.primarySmallLabel}>Approve</Text>
                      </Button>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </SectionCard>

        <SectionCard
          description="Links expire after seven days unless revoked sooner."
          right={invites.length > 0 ? (
            <Button compact onPress={() => setHideExpired((current) => !current)} variant="ghost">
              {hideExpired ? 'Show all' : 'Hide expired'}
            </Button>
          ) : undefined}
          title="Recent Invite Links"
        >
          {invitesLoading && !invitesLoaded ? (
            <StateView compact title="Loading invite links..." type="loading" />
          ) : visibleInvites.length === 0 ? (
            <Text style={[styles.emptyText, { color: palette.muted }]}>No invite links yet.</Text>
          ) : (
            <View style={styles.inviteList}>
              {visibleInvites.map((invite) => {
                const state = inviteState(invite);
                const active = state === 'Active';
                const stateColor = active ? palette.success : state === 'Expired' ? palette.warning : palette.danger;
                return (
                  <View key={invite.id} style={[styles.inviteCard, { borderColor: palette.border }]}>
                    <View style={styles.inviteTop}>
                      <View style={[styles.inviteState, { backgroundColor: `${stateColor}1f` }]}>
                        <Text style={[styles.inviteStateText, { color: stateColor }]}>{state}</Text>
                      </View>
                      <Text numberOfLines={1} style={[styles.inviteCode, { color: palette.text }]}>{invite.code}</Text>
                    </View>
                    <Text style={[styles.inviteMeta, { color: palette.muted }]}>Created {formatDate(invite.created_at)}</Text>
                    <Text style={[styles.inviteMeta, { color: palette.muted }]}>Expires {formatDate(invite.expires_at)}</Text>
                    <Text style={[styles.inviteMeta, { color: palette.muted }]}>
                      Uses: {invite.use_count} / {invite.max_uses ?? 'unlimited'}
                    </Text>
                    <View style={styles.inviteActions}>
                      <Button compact disabled={!active} onPress={() => void copyInvite(invite)} variant="secondary">
                        {copiedInviteId === invite.id
                          ? <Check color={palette.success} size={15} />
                          : <Copy color={palette.text} size={15} />}
                        <Text style={[styles.smallButtonLabel, { color: copiedInviteId === invite.id ? palette.success : palette.text }]}>
                          {copiedInviteId === invite.id ? 'Copied' : 'Copy Link'}
                        </Text>
                      </Button>
                      {active ? (
                        <Button
                          compact
                          loading={busyInviteId === invite.id}
                          onPress={() => requestRevokeInvite(invite)}
                          variant="ghost"
                        >
                          <Trash2 color={palette.danger} size={15} />
                          <Text style={[styles.smallButtonLabel, { color: palette.danger }]}>Revoke</Text>
                        </Button>
                      ) : null}
                    </View>
                  </View>
                );
              })}
              {hiddenInviteCount > 0 ? (
                <Text style={[styles.hiddenText, { color: palette.muted }]}>
                  {hiddenInviteCount} expired or revoked {hiddenInviteCount === 1 ? 'link is' : 'links are'} hidden.
                </Text>
              ) : null}
            </View>
          )}
        </SectionCard>
      </ScrollView>
    );
  };

  const renderPermissions = () => {
    if (!isOwner) {
      return (
        <View style={styles.flex}>
          <View style={styles.ownerOnlyIcon}>
            <ShieldAlert color={palette.muted} size={28} />
          </View>
          <StateView
            message="Permissions can only be changed by the group owner."
            title="Owner Only"
            type="empty"
          />
        </View>
      );
    }
    if (permissionsLoading && !permissions) {
      return <StateView title="Loading permissions" type="loading" />;
    }
    if (!permissions) {
      return (
        <StateView
          actionLabel="Retry"
          message={permissionsError || 'Could not load permissions.'}
          onAction={() => void loadPermissions()}
          title="Unable to load permissions"
          type="error"
        />
      );
    }
    return (
      <ScrollView contentContainerStyle={styles.content}>
        {permissionsError ? <FeedbackBanner message={permissionsError} onDismiss={() => setPermissionsError('')} /> : null}
        {permissionsSaving ? (
          <View style={styles.savingRow}>
            <ActivityIndicator color={palette.muted} size="small" />
            <Text style={[styles.savingText, { color: palette.muted }]}>Saving...</Text>
          </View>
        ) : null}

        <SectionCard title="Admins">
          <SwitchRow
            label="Remove Members?"
            onChange={(value) => updatePermission('admin_can_remove_members', value)}
            value={permissions.admin_can_remove_members}
          />
          <SwitchRow
            label="Approve Join Requests?"
            onChange={(value) => updatePermission('admin_can_approve_join_requests', value)}
            value={permissions.admin_can_approve_join_requests}
          />
          <SwitchRow
            label="Edit Member Nicknames?"
            onChange={(value) => updatePermission('admin_can_edit_member_nicknames', value)}
            value={permissions.admin_can_edit_member_nicknames}
          />
          <SwitchRow
            label="Edit Group Profile?"
            onChange={(value) => updatePermission('admin_can_edit_group_profile', value)}
            value={permissions.admin_can_edit_group_profile}
          />
          <SwitchRow
            label="Manage Invite Links?"
            onChange={(value) => updatePermission('admin_can_manage_invite_links', value)}
            value={permissions.admin_can_manage_invite_links}
          />
        </SectionCard>

        <SectionCard title="Attachments">
          <WhoChoice
            label="Who can send attachments?"
            onChange={(value) => updatePermission('who_can_send_attachments', value)}
            value={permissions.who_can_send_attachments}
          />
        </SectionCard>

        <SectionCard title="Nickname Rules">
          <WhoChoice
            label="Who can edit other members' nicknames?"
            onChange={(value) => updatePermission('who_can_edit_other_nicknames', value)}
            value={permissions.who_can_edit_other_nicknames}
          />
          <WhoChoice
            label="Who can edit their own nickname?"
            onChange={(value) => updatePermission('who_can_edit_own_nickname', value)}
            value={permissions.who_can_edit_own_nickname}
          />
        </SectionCard>

        <SectionCard title="Group Profile">
          <WhoChoice
            label="Who can edit the group name and image?"
            onChange={(value) => updatePermission('who_can_edit_group_profile', value)}
            value={permissions.who_can_edit_group_profile}
          />
        </SectionCard>

        <SectionCard title="Safety">
          <View style={styles.safetyContent}>
            <View style={[styles.safetyNotice, { backgroundColor: `${palette.warning}12`, borderColor: `${palette.warning}40` }]}>
              <Text style={[styles.safetyText, { color: palette.warning }]}>Owner is always allowed to manage the server.</Text>
            </View>
            <View style={[styles.safetyNotice, { backgroundColor: palette.surfaceRaised, borderColor: palette.border }]}>
              <Text style={[styles.safetyText, { color: palette.muted }]}>Some permissions can still be overridden by ownership.</Text>
            </View>
          </View>
        </SectionCard>
      </ScrollView>
    );
  };

  if (loading) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Group Settings" />
        <StateView title="Loading group settings" type="loading" />
      </Screen>
    );
  }

  if (loadError && members.length === 0) {
    return (
      <Screen>
        <AppHeader onBack={() => navigation.goBack()} title="Group Settings" />
        <StateView
          actionLabel="Retry"
          message={loadError}
          onAction={() => void loadDetail(true)}
          title="Unable to load group settings"
          type="error"
        />
      </Screen>
    );
  }

  return (
    <Screen keyboard={section === 'profile'}>
      <AppHeader
        onBack={() => section ? setSection(null) : navigation.goBack()}
        subtitle={section ? conversation.name || 'Unnamed Group' : `${members.length || conversation.member_count} members`}
        title={section ? sectionTitles[section] : 'Group Settings'}
      />
      {notice ? (
        <View style={styles.noticeWrap}>
          <FeedbackBanner kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />
        </View>
      ) : null}
      {!section
        ? renderMenu()
        : section === 'profile'
          ? renderProfile()
          : section === 'members'
            ? renderMembers()
            : section === 'invites'
              ? renderInvites()
              : renderPermissions()}

      <BottomSheet
        onClose={() => setSelectedMember(null)}
        title={selectedMember ? memberLabel(selectedMember) : 'Member Actions'}
        visible={Boolean(selectedMember)}
      >
        {selectedMember ? (
          <View style={styles.sheetActions}>
            {canEditNicknameFor(selectedMember) ? (
              <ActionRow
                icon={<Pencil color={palette.muted} size={17} />}
                label={selectedMember.nickname ? 'Edit Nickname' : 'Set Nickname'}
                onPress={() => openNicknameEditor(selectedMember)}
              />
            ) : null}
            {canTransferTo(selectedMember) ? (
              <ActionRow
                icon={<Crown color={palette.warning} size={17} />}
                label="Transfer Ownership"
                onPress={() => requestTransfer(selectedMember)}
              />
            ) : null}
            {canChangeRoleFor(selectedMember) ? (
              <ActionRow
                icon={<UserRoundCog color={palette.muted} size={17} />}
                label="Change Role"
                onPress={() => {
                  setSelectedMember(null);
                  setRoleMember(selectedMember);
                }}
              />
            ) : null}
            {canKickMember(selectedMember) ? (
              <ActionRow
                danger
                icon={<UserMinus color={palette.danger} size={17} />}
                label="Kick Member"
                onPress={() => requestKick(selectedMember)}
              />
            ) : null}
          </View>
        ) : null}
      </BottomSheet>

      <BottomSheet
        onClose={() => setNicknameMember(null)}
        title={nicknameMember ? `Nickname for ${accountLabel(nicknameMember)}` : 'Set Nickname'}
        visible={Boolean(nicknameMember)}
      >
        {nicknameMember ? (
          <View style={styles.sheetForm}>
            <Text style={[styles.sheetDescription, { color: palette.muted }]}>Set a group-specific nickname for this member.</Text>
            <TextField
              autoFocus
              editable={!busyMemberAction}
              maxLength={32}
              onChangeText={setNicknameDraft}
              placeholder="Enter a nickname..."
              value={nicknameDraft}
            />
            <View style={styles.sheetButtonRow}>
              {nicknameMember.nickname ? (
                <Button
                  compact
                  disabled={Boolean(busyMemberAction)}
                  onPress={() => setNicknameDraft('')}
                  variant="ghost"
                >
                  Remove nickname
                </Button>
              ) : <View style={styles.sheetSpacer} />}
              <Button compact disabled={Boolean(busyMemberAction)} onPress={() => setNicknameMember(null)} variant="secondary">Cancel</Button>
              <Button compact loading={busyMemberAction.startsWith('nickname:')} onPress={() => void saveMemberNickname()}>Save nickname</Button>
            </View>
          </View>
        ) : null}
      </BottomSheet>

      <BottomSheet
        onClose={() => setRoleMember(null)}
        title={roleMember ? `Change Role for ${accountLabel(roleMember)}` : 'Change Role'}
        visible={Boolean(roleMember)}
      >
        {roleMember ? (
          <View style={styles.sheetActions}>
            <Text style={[styles.sheetDescription, { color: palette.muted }]}>Update what this member can do in the group.</Text>
            <ActionRow
              detail="Can moderate members and help manage the group."
              disabled={roleMember.role === 'admin'}
              label="Admin"
              loading={busyMemberAction === `role:${roleMember.user_id}`}
              onPress={() => void changeMemberRole('admin')}
            />
            <ActionRow
              detail="Can participate without moderation access."
              disabled={roleMember.role === 'member'}
              label="Member"
              loading={busyMemberAction === `role:${roleMember.user_id}`}
              onPress={() => void changeMemberRole('member')}
            />
          </View>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: 14, padding: 18, paddingBottom: 44 },
  noticeWrap: { paddingHorizontal: 18, paddingTop: 12 },
  groupSummary: { alignItems: 'center', borderRadius: 17, borderWidth: 1, flexDirection: 'row', gap: 15, padding: 18 },
  summaryCopy: { flex: 1, minWidth: 0 },
  summaryName: { fontSize: 20, fontWeight: '800', lineHeight: 25 },
  summaryMembers: { fontSize: 12, fontWeight: '600', marginTop: 5 },
  category: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginBottom: -6, marginTop: 8, textTransform: 'uppercase' },
  menuGroup: { gap: 10 },
  profileContent: { gap: 14, padding: 16, paddingTop: 8 },
  iconActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  helpText: { fontSize: 12, lineHeight: 18 },
  buttonLabel: { fontSize: 12, fontWeight: '700' },
  primaryButtonLabel: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  smallButtonLabel: { fontSize: 11, fontWeight: '700' },
  primarySmallLabel: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  memberList: { gap: 9, padding: 12, paddingTop: 4 },
  memberCard: { alignItems: 'center', borderRadius: 13, borderWidth: 1, flexDirection: 'row', gap: 10, padding: 11 },
  memberCopy: { flex: 1, minWidth: 0 },
  memberNameLine: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  memberName: { flexShrink: 1, fontSize: 14, fontWeight: '700' },
  memberMeta: { fontSize: 11, marginTop: 4 },
  youBadge: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  youText: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase' },
  moreButton: { alignItems: 'center', borderRadius: 9, height: 38, justifyContent: 'center', width: 38 },
  leavingContent: { gap: 14, padding: 16, paddingTop: 7 },
  leaveCopyRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  leaveDescription: { flex: 1, fontSize: 12, lineHeight: 18 },
  sectionActions: { padding: 16, paddingTop: 6 },
  emptyText: { fontSize: 13, lineHeight: 20, padding: 17, paddingTop: 8 },
  requestList: { gap: 10, padding: 12, paddingTop: 5 },
  requestCard: { borderRadius: 13, borderWidth: 1, gap: 12, padding: 12 },
  requestIdentity: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  requestCopy: { flex: 1, minWidth: 0 },
  requestName: { fontSize: 14, fontWeight: '700' },
  requestMeta: { fontSize: 11, marginTop: 3 },
  requestActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  inviteList: { gap: 10, padding: 12, paddingTop: 5 },
  inviteCard: { borderRadius: 13, borderWidth: 1, padding: 13 },
  inviteTop: { alignItems: 'center', flexDirection: 'row', gap: 8, marginBottom: 8 },
  inviteState: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  inviteStateText: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase' },
  inviteCode: { flex: 1, fontSize: 13, fontWeight: '700' },
  inviteMeta: { fontSize: 11, lineHeight: 17 },
  inviteActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 11 },
  hiddenText: { fontSize: 11, lineHeight: 17, padding: 4, textAlign: 'center' },
  ownerOnlyIcon: { alignItems: 'center', alignSelf: 'center', height: 0, justifyContent: 'center', top: 100, width: 52, zIndex: 1 },
  savingRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  savingText: { fontSize: 12, fontWeight: '600' },
  safetyContent: { gap: 8, padding: 14, paddingTop: 5 },
  safetyNotice: { borderRadius: 11, borderWidth: 1, padding: 12 },
  safetyText: { fontSize: 11, lineHeight: 17 },
  sheetActions: { gap: 2, paddingBottom: 2 },
  sheetForm: { gap: 13, padding: 4, paddingBottom: 2 },
  sheetDescription: { fontSize: 12, lineHeight: 18 },
  sheetButtonRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  sheetSpacer: { flex: 1 },
});
