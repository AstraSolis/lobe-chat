import { Text } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Center } from 'react-layout-kit';

import { useChatStore } from '@/store/chat';
import { chatSelectors } from '@/store/chat/selectors';
import { useSessionStore } from '@/store/session';
import { shinyTextStylish } from '@/styles/loading';

const useStyles = createStyles(({ token }) => ({
  shinyText: shinyTextStylish(token),
}));

const OrchestratorThinkingTag = memo(() => {
  const { t } = useTranslation('chat');
  const activeGroupId = useSessionStore((s) => s.activeId);
  const isSupervisorLoading = useChatStore(chatSelectors.isSupervisorLoading(activeGroupId || ''));
  const { styles } = useStyles();

  if (!isSupervisorLoading) return null;

  return (
    <Center gap={4} horizontal paddingBlock={'12px 24px'}>
      <Text className={styles.shinyText} type={'secondary'}>
        {t('group.orchestratorThinking')}
      </Text>
    </Center>
  );
});

export default OrchestratorThinkingTag;
