import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';
import { askUserTool } from '../src/agent/tools';
import type { QuestionRequest } from '../src/shared/protocol';

function toolbox(): ToolBox {
  return new ToolBox({
    root: process.cwd(),
    diffManager: {} as never,
    terminalTimeoutSeconds: 15,
    autoApproveTerminal: false,
    autoApproveEdits: true,
    safeCommandsOnly: true,
    yolo: false,
    autoApproveMcp: true,
    checkDiagnostics: false,
    sandbox: 'off',
  });
}

describe('ask_user batch questions', () => {
  it('advertises the batch form while keeping the single-question fields', () => {
    const properties = askUserTool.parameters.properties as Record<string, unknown>;
    expect(properties.questions).toBeDefined();
    expect(properties.question).toBeDefined();
    expect(askUserTool.parameters.required).toBeUndefined();
  });

  it('posts one card with all questions and returns the formatted answer', async () => {
    let request: QuestionRequest | undefined;
    const answer = await toolbox().execute(
      'ask_user',
      JSON.stringify({
        questions: [
          {
            question: 'Which database?',
            header: 'Database',
            options: [{ label: 'Postgres' }, { label: 'SQLite' }],
          },
          {
            question: 'Run migrations now?',
            options: [{ label: 'Yes' }, { label: 'No' }],
            multiple: false,
            custom: false,
          },
        ],
      }),
      {
        requestTerminalApproval: async () => 'deny',
        askUser: async (incoming) => {
          request = incoming;
          return 'Which database?: Postgres\nRun migrations now?: Yes';
        },
      },
    );
    expect(request?.questions).toHaveLength(2);
    expect(request?.question).toBe('Which database?');
    expect(request?.options.map((option) => option.label)).toEqual(['Postgres', 'SQLite']);
    expect(request?.questions?.[0].custom).toBe(true);
    expect(request?.questions?.[1].custom).toBe(false);
    expect(answer).toBe('Which database?: Postgres\nRun migrations now?: Yes');
  });

  it('clamps option lists to five and skips empty questions', async () => {
    let request: QuestionRequest | undefined;
    await toolbox().execute(
      'ask_user',
      JSON.stringify({
        questions: [
          { question: 'Pick one', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((label) => ({ label })) },
          { question: '   ' },
        ],
      }),
      {
        requestTerminalApproval: async () => 'deny',
        askUser: async (incoming) => {
          request = incoming;
          return 'Pick one: A';
        },
      },
    );
    expect(request?.questions).toHaveLength(1);
    expect(request?.questions?.[0].options).toHaveLength(5);
  });

  it('still supports the legacy single-question call', async () => {
    let request: QuestionRequest | undefined;
    const answer = await toolbox().execute(
      'ask_user',
      JSON.stringify({ question: 'Deploy now?', header: 'Deploy', options: [{ label: 'Yes' }], multiple: false }),
      {
        requestTerminalApproval: async () => 'deny',
        askUser: async (incoming) => {
          request = incoming;
          return 'Yes';
        },
      },
    );
    expect(request?.questions).toBeUndefined();
    expect(request?.question).toBe('Deploy now?');
    expect(answer).toBe('Yes');
  });

  it('reports a dismissal when the answer is empty', async () => {
    const result = await toolbox().execute(
      'ask_user',
      JSON.stringify({ question: 'Deploy now?' }),
      { requestTerminalApproval: async () => 'deny', askUser: async () => '' },
    );
    expect(result).toContain('dismissed');
  });
});
