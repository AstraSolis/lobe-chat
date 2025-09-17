'use client';

import { Grid, Tag, Text } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flexbox } from 'react-layout-kit';

import { useChatGroupStore } from '@/store/chatGroup';
import { chatGroupSelectors } from '@/store/chatGroup/selectors';
import { useSessionStore } from '@/store/session';
import { sessionSelectors } from '@/store/session/selectors';
import { LobeAgentSession, LobeGroupSession, LobeSessionType } from '@/types/session';

import AgentCard from './AgentCard';

const useStyles = createStyles(({ css }) => ({
  container: css`
    width: 100%;
  `,
}));

// Pre-defined host member
const HOST_MEMBER: LobeAgentSession = {
  config: {
    chatConfig: {},
    id: 'host-member',
    model: 'gpt-4',
    params: {},
    systemRole: 'You are a group host responsible for moderating the conversation.',
    tts: {
      sttLocale: 'auto',
      ttsService: 'openai' as const,
      voice: {
        openai: 'alloy',
      },
    },
  },
  createdAt: new Date(),
  id: 'host-member',
  meta: {
    avatar: '🤖',
    description: 'Group conversation host',
    title: 'Host',
  },
  model: 'gpt-4',
  type: LobeSessionType.Agent,
  updatedAt: new Date(),
};

const GroupMembers = memo(() => {
  const { t } = useTranslation('setting');
  const { styles } = useStyles();
  const [loadingAgentId, setLoadingAgentId] = useState<string | null>(null);

  const activeGroupId = useSessionStore((s) => s.activeId);
  const currentSession = useSessionStore(sessionSelectors.currentSession) as LobeGroupSession;
  const groupConfig = useChatGroupStore(chatGroupSelectors.currentGroupConfig);

  const addAgentsToGroup = useChatGroupStore((s) => s.addAgentsToGroup);
  const removeAgentFromGroup = useChatGroupStore((s) => s.removeAgentFromGroup);
  const updateGroupConfig = useChatGroupStore((s) => s.updateGroupConfig);
  const refreshSessions = useSessionStore((s) => s.refreshSessions);

  // Get all agent sessions
  const agentSessions = useSessionStore((s) => {
    const allSessions = s.sessions || [];
    return allSessions.filter(
      (session) => session.type === LobeSessionType.Agent,
    ) as LobeAgentSession[];
  });

  const currentSessionId = useSessionStore((s) => s.activeId);

  console.log("enableSupervisor", groupConfig?.enableSupervisor);

  const isSupervisorEnabled = Boolean(groupConfig?.enableSupervisor);

  // Get member IDs from current session
  const memberIds = useMemo(() => {
    return currentSession?.members?.map((member: any) => member.id) || [];
  }, [currentSession?.members]);

  // Separate agents into two groups: in group and not in group
  const { agentsInGroup, agentsNotInGroup } = useMemo(() => {
    const inGroup: LobeAgentSession[] = [];
    const notInGroup: LobeAgentSession[] = [];

    agentSessions.forEach((agent) => {
      const agentId = agent.config?.id;
      if (!agentId || agent.id === currentSessionId) return; // Skip current session

      if (memberIds.includes(agentId)) {
        inGroup.push(agent);
      } else {
        notInGroup.push(agent);
      }
    });

    const finalInGroup = [...inGroup];
    const finalNotInGroup = [...notInGroup];

    if (isSupervisorEnabled) {
      finalInGroup.unshift(HOST_MEMBER);
    } else if (!memberIds.includes(HOST_MEMBER.config.id)) {
      finalNotInGroup.unshift(HOST_MEMBER);
    }

    return { agentsInGroup: finalInGroup, agentsNotInGroup: finalNotInGroup };
  }, [agentSessions, isSupervisorEnabled, memberIds, currentSessionId]);

  const handleAgentAction = async (agentId: string, action: 'add' | 'remove') => {
    if (!activeGroupId) {
      console.error('No active group to perform action on');
      return;
    }

    console.log(`Attempting to ${action} agent:`, { action, activeGroupId, agentId });

    // Check if this is the host member
    const isHostMember = agentId === HOST_MEMBER.config.id;

    // Set loading state for this specific agent
    setLoadingAgentId(agentId);

    try {
      if (action === 'add') {
        if (isHostMember) {
          // Host toggle updates supervisor flag instead of modifying members
          await updateGroupConfig({ enableSupervisor: true });
          console.log('Enabled supervisor');
        } else {
          await addAgentsToGroup(activeGroupId, [agentId]);
          console.log(`Successfully added agent ${agentId} to group ${activeGroupId}`);
        }
      } else {
        if (isHostMember) {
          // Host toggle updates supervisor flag instead of modifying members
          await updateGroupConfig({ enableSupervisor: false });
          console.log('Disabled supervisor');
        } else {
          await removeAgentFromGroup(activeGroupId, agentId);
          console.log(`Successfully removed agent ${agentId} from group ${activeGroupId}`);
        }
      }

      // Refresh session data to reflect the changes
      await refreshSessions();
    } catch (error) {
      console.error(`Failed to ${action} agent ${action === 'add' ? 'to' : 'from'} group:`, error);
    } finally {
      // Clear loading state
      setLoadingAgentId(null);
    }
  };

  return (
    <Flexbox className={styles.container} gap={40}>
      {/* Agents in Group Section */}
      <Flexbox gap={24}>
        <Flexbox align={'center'} gap={8} horizontal>
          <Text strong style={{ fontSize: 18 }}>
            {t('settingGroupMembers.groupMembers')}
          </Text>
          <Tag>{agentsInGroup.length}</Tag>
        </Flexbox>
        <Grid gap={16} rows={3}>
          {agentsInGroup.map((agent) => {
            const isHostMember = agent.config?.id === HOST_MEMBER.config.id;
            return (
              <AgentCard
                agent={agent}
                inGroup={true}
                isHost={isHostMember}
                key={agent.config?.id}
                onAction={handleAgentAction}
                operationLoading={loadingAgentId === agent.config?.id}
              />
            );
          })}
          {agentsInGroup.length === 0 && (
            <Text style={{ color: '#999', gridColumn: '1 / -1', padding: 40, textAlign: 'center' }}>
              {t('settingGroupMembers.noMembersInGroup')}
            </Text>
          )}
        </Grid>
      </Flexbox>

      {/* Agents not in Group Section */}
      <Flexbox gap={24}>
        <Flexbox align={'center'} gap={8} horizontal>
          <Text strong style={{ fontSize: 18 }}>
            {t('settingGroupMembers.availableAgents')}
          </Text>
          <Tag>{agentsNotInGroup.length}</Tag>
        </Flexbox>
        <Grid gap={16} rows={3}>
          {agentsNotInGroup.map((agent) => {
            const isHostMember = agent.config?.id === HOST_MEMBER.config.id;
            return (
              <AgentCard
                agent={agent}
                inGroup={false} // Always show as "not in group" since it's in the Available Agents section
                isHost={isHostMember}
                key={agent.config?.id}
                onAction={handleAgentAction}
                operationLoading={loadingAgentId === agent.config?.id}
              />
            );
          })}
          {agentsNotInGroup.length === 0 && (
            <Text style={{ color: '#999', gridColumn: '1 / -1', padding: 40, textAlign: 'center' }}>
              {t('settingGroupMembers.noAvailableAgents')}
            </Text>
          )}
        </Grid>
      </Flexbox>
    </Flexbox>
  );
});

export default GroupMembers;
