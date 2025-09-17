import { groupChatPrompts, groupSupervisorPrompts } from '@lobechat/prompts';
import { ChatMessage, GroupMemberWithAgent } from '@lobechat/types';

import { chatService } from '@/services/chat';

export interface SupervisorDecision {
  id: string;
  // target agent ID or "user" for DM, omit for group message
  instruction?: string;
  // agent ID who should respond
  target?: string; // optional instruction from supervisor to the agent
}

export type SupervisorDecisionList = SupervisorDecision[]; // Empty array = stop conversation

interface SupervisorDecisionResponse {
  decisions: Array<{
    id: string;
    instruction?: string;
    target?: string;
  }>;
}

export interface SupervisorContext {
  abortController?: AbortController;
  allowDM?: boolean;
  availableAgents: GroupMemberWithAgent[];
  groupId: string;
  messages: ChatMessage[];
  model: string;
  provider: string;
  systemPrompt?: string;
  userName?: string;
}

/**
 * Core supervisor runtime that orchestrates the conversation between agents in group chat
 */
export class GroupChatSupervisor {
  /**
   * Make decision on who should speak next
   */
  async makeDecision(context: SupervisorContext): Promise<SupervisorDecisionList> {
    const { messages, availableAgents, userName, systemPrompt, allowDM } = context;

    // If no agents available, stop conversation
    if (availableAgents.length === 0) {
      return [];
    }

    try {
      // Create supervisor prompt with conversation context
      const conversationHistory = groupSupervisorPrompts(messages);

      const supervisorPrompt = groupChatPrompts.buildSupervisorPrompt({
        allowDM,
        availableAgents: availableAgents
          .filter((agent) => agent.id)
          .map((agent) => ({ id: agent.id!, title: agent.title })),
        conversationHistory,
        systemPrompt,
        userName,
      });

      const response = await this.callLLMForDecision(supervisorPrompt, context);

      const decision = this.parseDecision(response, availableAgents);

      return decision;
    } catch (error) {
      // Re-throw the error so it can be caught and displayed to the user via toast
      throw new Error(
        `Supervisor decision failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Call LLM service to get supervisor decision
   */
  private async callLLMForDecision(
    prompt: string,
    context: SupervisorContext,
  ): Promise<SupervisorDecisionResponse | string> {
    const supervisorConfig = {
      model: context.model,
      provider: context.provider,
      temperature: 0.3,
    };

    const responseFormat = {
      json_schema: {
        name: 'supervisor_decision_response',
        schema: {
          additionalProperties: false,
          properties: {
            decisions: {
              items: {
                additionalProperties: false,
                properties: {
                  id: { description: 'ID of the agent who should speak', type: 'string' },
                  instruction: { description: 'Optional instruction for the agent', type: 'string' },
                  target: {
                    description: 'Target agent ID or "user" for DM',
                    type: 'string',
                  },
                },
                required: ['id'],
                type: 'object',
              },
              type: 'array',
            },
          },
          required: ['decisions'],
          type: 'object',
        },
      },
      type: 'json_schema',
    } as const;

    try {
      const response = await chatService.getStructuredCompletion<SupervisorDecisionResponse>(
        {
          messages: [{ content: prompt, role: 'user' }],
          response_format: responseFormat,
          stream: false,
          ...supervisorConfig,
        },
        {
          signal: context.abortController?.signal,
        },
      );

      console.log('Supervisor LLM response:', response);

      return response;
    } catch (err) {
      if (this.isAbortError(err, context)) {
        throw this.createAbortError();
      }

      if (this.shouldFallbackToStreaming(err)) {
        return this.callLLMForDecisionWithStreaming(prompt, context, supervisorConfig);
      }

      console.error('Supervisor LLM error:', err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private shouldFallbackToStreaming(error: unknown) {
    if (!error) return false;
    if (error instanceof SyntaxError) return true;

    const message = (error as Error)?.message || '';

    return /unexpected token|invalid json|not valid json/i.test(message);
  }

  private createAbortError() {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    return abortError;
  }

  private isAbortError(error: unknown, context: SupervisorContext) {
    if (context.abortController?.signal.aborted) return true;

    const name = (error as DOMException)?.name;

    return name === 'AbortError';
  }

  private async callLLMForDecisionWithStreaming(
    prompt: string,
    context: SupervisorContext,
    supervisorConfig: {
      model: string;
      provider: string;
      temperature: number;
    },
  ) {
    let res = '';
    let error: Error | null = null;

    await chatService.fetchPresetTaskResult({
      abortController: context.abortController,
      onError: (err) => {
        console.error('Supervisor LLM error (fallback):', err);
        error = err;
      },
      onFinish: async (content) => {
        console.log('Supervisor LLM response (fallback):', content);
        res = content.trim();
      },
      onLoadingChange: (loading) => {
        console.log('Supervisor LLM loading state (fallback):', loading);
      },
      params: {
        messages: [{ content: prompt, role: 'user' }],
        stream: false,
        ...supervisorConfig,
      },
    });

    if (context.abortController?.signal.aborted) {
      throw this.createAbortError();
    }

    if (error) {
      throw error;
    }

    if (!res) {
      throw this.createAbortError();
    }

    return res;
  }

  /**
   * Parse LLM response into decision
   */
  private parseDecision(
    response: SupervisorDecisionResponse | string,
    availableAgents: GroupMemberWithAgent[],
  ): SupervisorDecisionList {
    try {
      const decisions = this.normalizeDecisions(response);

      if (!Array.isArray(decisions)) {
        throw new Error('Response must include a decisions array');
      }

      // Empty array = stop conversation
      if (decisions.length === 0) {
        return [];
      }

      // Filter and validate the response objects
      const normalizedDecisions = decisions
        .filter(
          (item: any) =>
            typeof item === 'object' &&
            item !== null &&
            typeof item.id === 'string' &&
            availableAgents.some((agent) => agent.id === item.id),
        )
        .map((item: any) => ({
          id: item.id,
          instruction: item.instruction || undefined,
          target: item.target || undefined,
        }));

      return normalizedDecisions;
    } catch (error) {
      // Re-throw the error with more context so it can be caught and displayed to the user via toast
      throw new Error(
        `Failed to parse supervisor decision: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private normalizeDecisions(response: SupervisorDecisionResponse | string) {
    if (typeof response === 'string') {
      const startIndex = response.indexOf('[');
      const endIndex = response.lastIndexOf(']');
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        throw new Error('No JSON array found in response');
      }

      const jsonText = response.slice(startIndex, endIndex + 1);
      return JSON.parse(jsonText);
    }

    return response?.decisions;
  }

  /**
   * Quick validation of decision against group rules
   */
  validateDecision(decisions: SupervisorDecisionList, context: SupervisorContext): boolean {
    const { availableAgents } = context;

    // Empty array is always valid (means stop)
    if (decisions.length === 0) return true;

    return decisions.every((decision) => {
      // Validate speaker exists
      const speakerExists = availableAgents.some((agent) => agent.id === decision.id);
      if (!speakerExists) return false;

      // Validate target exists if specified
      if (decision.target) {
        return (
          decision.target === 'user' ||
          availableAgents.some((agent) => agent.id === decision.target)
        );
      }

      return true;
    });
  }
}
