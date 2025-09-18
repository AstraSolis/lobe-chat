'use client';

import { ActionIcon, Tabs } from '@lobehub/ui';
import { Empty, Tag } from 'antd';
import isEqual from 'fast-deep-equal';
import { CheckCircle, Circle, Edit, UserPlus } from 'lucide-react';
import { MouseEvent, memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flexbox } from 'react-layout-kit';

import { useChatStore } from '@/store/chat';
import { useSessionStore } from '@/store/session';
import { sessionSelectors } from '@/store/session/slices/session/selectors';
import type { LobeGroupSession } from '@/types/session';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import ConfigLayout from '../ConfigLayout';
import GroupMember from './GroupMember';
import GroupRole from './GroupRole';

const GroupTodoList = memo<{ groupId?: string }>(({ groupId }) => {
  const { t } = useTranslation('chat');
  const activeTopicId = useChatStore((state) => state.activeTopicId);
  const todos = useChatStore(
    (state) =>
      !groupId ? [] : state.supervisorTodos[messageMapKey(groupId, activeTopicId)] ?? [],
    isEqual,
  );

  const emptyProps = useMemo(
    () => ({
      image: Empty.PRESENTED_IMAGE_SIMPLE,
    }),
    [],
  );

  if (!groupId) {
    return (
      <Empty
        {...emptyProps}
        description={t('groupSidebar.todos.noSession', {
          defaultValue: 'Select a group to view todo list.',
        })}
      />
    );
  }

  if (!todos.length) {
    return (
      <Empty
        {...emptyProps}
        description={t('groupSidebar.todos.empty', {
          defaultValue: 'No tasks yet.',
        })}
      />
    );
  }

  return (
    <Flexbox gap={8} style={{ paddingBlock: 8 }}>
      {todos.map((item, index) => (
        <Flexbox
          key={`${item.content}-${index}`}
          align={'center'}
          gap={8}
          horizontal
          style={{
            background: 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.04))',
            borderRadius: 8,
            padding: '8px 12px',
          }}
        >
          {item.finished ? (
            <CheckCircle
              size={16}
              strokeWidth={2}
              style={{ color: 'var(--ant-color-success, #52c41a)' }}
            />
          ) : (
            <Circle
              size={16}
              strokeWidth={2}
              style={{ color: 'var(--ant-color-text-tertiary, rgba(0,0,0,0.45))' }}
            />
          )}
          <Flexbox flex={1} style={{ minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 500, wordBreak: 'break-word' }}>{item.content}</span>
          </Flexbox>
          <Tag color={item.finished ? 'success' : undefined}>
            {item.finished
              ? t('groupSidebar.todos.status.finished', { defaultValue: 'Done' })
              : t('groupSidebar.todos.status.pending', { defaultValue: 'Pending' })}
          </Tag>
        </Flexbox>
      ))}
    </Flexbox>
  );
});

GroupTodoList.displayName = 'GroupTodoList';

const GroupChatSidebar = memo(() => {
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editorModalOpen, setEditorModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('members');
  const { t } = useTranslation(['chat', 'common']);

  const [sessionId] = useSessionStore((s) => [s.activeId]);
  const currentSession = useSessionStore(
    (state) => {
      const session = sessionSelectors.currentSession(state);
      return session?.type === 'group' ? (session as LobeGroupSession) : undefined;
    },
    isEqual,
  );

  const handleAddMember = (e: MouseEvent) => {
    e.stopPropagation();
    setAddModalOpen(true);
  };

  const handleOpenWithEdit = (e: MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
    setEditorModalOpen(true);
  };

  const actions = activeTab === 'members'
    ? (
        <ActionIcon
          icon={UserPlus}
          onClick={handleAddMember}
          size={'small'}
          title={t('groupSidebar.members.addMember')}
        />
      )
    : activeTab === 'role'
      ? (
          <ActionIcon
            icon={Edit}
            onClick={handleOpenWithEdit}
            size={'small'}
            title={t('edit', { ns: 'common' })}
          />
        )
      : undefined;

  return (
    <ConfigLayout
      actions={actions}
      expandedHeight={activeTab === 'members' ? '40vh' : 200}
      headerStyle={{ paddingBlock: 0, paddingLeft: 0 }}
      sessionId={sessionId}
      title={
        <Tabs
          activeKey={activeTab}
          compact
          items={[
            {
              key: 'members',
              label: t('groupSidebar.tabs.members'),
            },
            {
              key: 'role',
              label: t('groupSidebar.tabs.role'),
            },
            {
              key: 'todos',
              label: t('groupSidebar.tabs.todos', { defaultValue: 'Todo List' }),
            },
          ]}
          onChange={(key) => setActiveTab(key)}
          onClick={(e) => {
            e.stopPropagation();
          }}
          size="small"
          variant="rounded"
        />
      }
    >
      {activeTab === 'members' && (
        <GroupMember
          addModalOpen={addModalOpen}
          currentSession={currentSession}
          onAddModalOpenChange={setAddModalOpen}
          sessionId={sessionId}
        />
      )}
      {activeTab === 'role' && (
        <GroupRole
          currentSession={currentSession}
          editing={editing}
          editorModalOpen={editorModalOpen}
          setEditing={setEditing}
          setEditorModalOpen={setEditorModalOpen}
        />
      )}
      {activeTab === 'todos' && <GroupTodoList groupId={sessionId} />}
    </ConfigLayout>
  );
});

export default GroupChatSidebar;
