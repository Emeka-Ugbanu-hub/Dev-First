export type CatalogReasoning =
  | { kind: 'toggle' }
  | { kind: 'effort'; values: string[] }
  | { kind: 'budget'; min: number; max: number };

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  reasoning?: CatalogReasoning;
  capabilities?: string[];
}

export const CATALOG: Record<string, Record<string, CatalogModel>> = {
  "openai": {
    "chatgpt-image-latest": {
      "id": "chatgpt-image-latest",
      "name": "chatgpt-image-latest",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "vision"
      ]
    },
    "gpt-3.5-turbo": {
      "id": "gpt-3.5-turbo",
      "name": "GPT-3.5-turbo",
      "contextWindow": 16385,
      "maxOutput": 4096
    },
    "gpt-4": {
      "id": "gpt-4",
      "name": "GPT-4",
      "contextWindow": 8192,
      "maxOutput": 8192,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-4-turbo": {
      "id": "gpt-4-turbo",
      "name": "GPT-4 Turbo",
      "contextWindow": 128000,
      "maxOutput": 4096,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-4.1": {
      "id": "gpt-4.1",
      "name": "GPT-4.1",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-4.1-mini": {
      "id": "gpt-4.1-mini",
      "name": "GPT-4.1 mini",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-4.1-nano": {
      "id": "gpt-4.1-nano",
      "name": "GPT-4.1 nano",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-4o": {
      "id": "gpt-4o",
      "name": "GPT-4o",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-4o-2024-05-13": {
      "id": "gpt-4o-2024-05-13",
      "name": "GPT-4o (2024-05-13)",
      "contextWindow": 128000,
      "maxOutput": 4096,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-4o-2024-08-06": {
      "id": "gpt-4o-2024-08-06",
      "name": "GPT-4o (2024-08-06)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-4o-2024-11-20": {
      "id": "gpt-4o-2024-11-20",
      "name": "GPT-4o (2024-11-20)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-4o-mini": {
      "id": "gpt-4o-mini",
      "name": "GPT-4o mini",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5": {
      "id": "gpt-5",
      "name": "GPT-5",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5-mini": {
      "id": "gpt-5-mini",
      "name": "GPT-5 Mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5-nano": {
      "id": "gpt-5-nano",
      "name": "GPT-5 Nano",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5-pro": {
      "id": "gpt-5-pro",
      "name": "GPT-5 Pro",
      "contextWindow": 400000,
      "maxOutput": 272000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.1": {
      "id": "gpt-5.1",
      "name": "GPT-5.1",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.2": {
      "id": "gpt-5.2",
      "name": "GPT-5.2",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.2-chat-latest": {
      "id": "gpt-5.2-chat-latest",
      "name": "GPT-5.2 Chat",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.2-pro": {
      "id": "gpt-5.2-pro",
      "name": "GPT-5.2 Pro",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.3-chat-latest": {
      "id": "gpt-5.3-chat-latest",
      "name": "GPT-5.3 Chat (latest)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.3-codex": {
      "id": "gpt-5.3-codex",
      "name": "GPT-5.3 Codex",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.3-codex-spark": {
      "id": "gpt-5.3-codex-spark",
      "name": "GPT-5.3 Codex Spark",
      "contextWindow": 128000,
      "maxOutput": 32000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.4": {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.4-mini": {
      "id": "gpt-5.4-mini",
      "name": "GPT-5.4 mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.4-nano": {
      "id": "gpt-5.4-nano",
      "name": "GPT-5.4 nano",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.4-pro": {
      "id": "gpt-5.4-pro",
      "name": "GPT-5.4 Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-5.5": {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.5-pro": {
      "id": "gpt-5.5-pro",
      "name": "GPT-5.5 Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.6": {
      "id": "gpt-5.6",
      "name": "GPT-5.6",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.6-luna": {
      "id": "gpt-5.6-luna",
      "name": "GPT-5.6 Luna",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.6-sol": {
      "id": "gpt-5.6-sol",
      "name": "GPT-5.6 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-5.6-terra": {
      "id": "gpt-5.6-terra",
      "name": "GPT-5.6 Terra",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-6-astra": {
      "id": "gpt-6-astra",
      "name": "GPT-6 Astra",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-6-luna": {
      "id": "gpt-6-luna",
      "name": "GPT-6 Luna",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-6-sol": {
      "id": "gpt-6-sol",
      "name": "GPT-6 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-6.1-sol": {
      "id": "gpt-6.1-sol",
      "name": "GPT-6.1 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-daybreak-blue-latest": {
      "id": "gpt-daybreak-blue-latest",
      "name": "Daybreak Blue",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "gpt-daybreak-red-latest": {
      "id": "gpt-daybreak-red-latest",
      "name": "Daybreak Red",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gpt-image-1": {
      "id": "gpt-image-1",
      "name": "gpt-image-1",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "vision"
      ]
    },
    "gpt-image-1-mini": {
      "id": "gpt-image-1-mini",
      "name": "gpt-image-1-mini",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "vision"
      ]
    },
    "gpt-image-1.5": {
      "id": "gpt-image-1.5",
      "name": "gpt-image-1.5",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "vision"
      ]
    },
    "gpt-image-2": {
      "id": "gpt-image-2",
      "name": "gpt-image-2",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "vision"
      ]
    },
    "gpt-realtime-2.1": {
      "id": "gpt-realtime-2.1",
      "name": "GPT-Realtime-2.1",
      "contextWindow": 128000,
      "maxOutput": 32000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "o1": {
      "id": "o1",
      "name": "o1",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "o1-pro": {
      "id": "o1-pro",
      "name": "o1-pro",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "o3": {
      "id": "o3",
      "name": "o3",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "o3-mini": {
      "id": "o3-mini",
      "name": "o3-mini",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "o3-pro": {
      "id": "o3-pro",
      "name": "o3-pro",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "o4-mini": {
      "id": "o4-mini",
      "name": "o4-mini",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "text-embedding-3-large": {
      "id": "text-embedding-3-large",
      "name": "text-embedding-3-large",
      "contextWindow": 8191,
      "maxOutput": 3072
    },
    "text-embedding-3-small": {
      "id": "text-embedding-3-small",
      "name": "text-embedding-3-small",
      "contextWindow": 8191,
      "maxOutput": 1536
    },
    "text-embedding-ada-002": {
      "id": "text-embedding-ada-002",
      "name": "text-embedding-ada-002",
      "contextWindow": 8192,
      "maxOutput": 1536
    }
  },
  "anthropic": {
    "claude-fable-5": {
      "id": "claude-fable-5",
      "name": "Claude Fable 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-fable-5-1": {
      "id": "claude-fable-5-1",
      "name": "Claude Fable 5.1",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-haiku-4-5": {
      "id": "claude-haiku-4-5",
      "name": "Claude Haiku 4.5 (latest)",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "budget",
        "min": 1024,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-haiku-4-5-20251001": {
      "id": "claude-haiku-4-5-20251001",
      "name": "Claude Haiku 4.5",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "budget",
        "min": 1024,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-4-5": {
      "id": "claude-opus-4-5",
      "name": "Claude Opus 4.5 (latest)",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-4-5-20251101": {
      "id": "claude-opus-4-5-20251101",
      "name": "Claude Opus 4.5",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-4-6": {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-4-7": {
      "id": "claude-opus-4-7",
      "name": "Claude Opus 4.7",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-4-8": {
      "id": "claude-opus-4-8",
      "name": "Claude Opus 4.8",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-5": {
      "id": "claude-opus-5",
      "name": "Claude Opus 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-opus-5-5": {
      "id": "claude-opus-5-5",
      "name": "Claude Opus 5.5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-sonnet-4-5": {
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5 (latest)",
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "budget",
        "min": 1024,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-sonnet-4-5-20250929": {
      "id": "claude-sonnet-4-5-20250929",
      "name": "Claude Sonnet 4.5",
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "budget",
        "min": 1024,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-sonnet-4-6": {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-sonnet-5": {
      "id": "claude-sonnet-5",
      "name": "Claude Sonnet 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "claude-sonnet-5-5": {
      "id": "claude-sonnet-5-5",
      "name": "Claude Sonnet 5.5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    }
  },
  "gemini": {
    "deep-research-max-preview-04-2026": {
      "id": "deep-research-max-preview-04-2026",
      "name": "Deep Research Max Preview (Apr-21-2026)",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "deep-research-preview-04-2026": {
      "id": "deep-research-preview-04-2026",
      "name": "Deep Research Preview (Apr-21-2026)",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-2.5-computer-use-preview-10-2025": {
      "id": "gemini-2.5-computer-use-preview-10-2025",
      "name": "Gemini 2.5 Computer Use Preview 10-2025",
      "contextWindow": 128000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gemini-2.5-flash": {
      "id": "gemini-2.5-flash",
      "name": "Gemini 2.5 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 0,
        "max": 24576
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-2.5-flash-image": {
      "id": "gemini-2.5-flash-image",
      "name": "Nano Banana",
      "contextWindow": 32768,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "gemini-2.5-flash-lite": {
      "id": "gemini-2.5-flash-lite",
      "name": "Gemini 2.5 Flash-Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 512,
        "max": 24576
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-2.5-flash-preview-tts": {
      "id": "gemini-2.5-flash-preview-tts",
      "name": "Gemini 2.5 Flash Preview TTS",
      "contextWindow": 8192,
      "maxOutput": 16384
    },
    "gemini-2.5-pro": {
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 128,
        "max": 32768
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-2.5-pro-preview-tts": {
      "id": "gemini-2.5-pro-preview-tts",
      "name": "Gemini 2.5 Pro Preview TTS",
      "contextWindow": 8192,
      "maxOutput": 16384
    },
    "gemini-3-flash-preview": {
      "id": "gemini-3-flash-preview",
      "name": "Gemini 3 Flash Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3-pro-image": {
      "id": "gemini-3-pro-image",
      "name": "Nano Banana Pro",
      "contextWindow": 65536,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high"
        ]
      },
      "capabilities": [
        "vision"
      ]
    },
    "gemini-3-pro-image-preview": {
      "id": "gemini-3-pro-image-preview",
      "name": "Nano Banana Pro",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "gemini-3.1-flash-image": {
      "id": "gemini-3.1-flash-image",
      "name": "Nano Banana 2",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "high"
        ]
      },
      "capabilities": [
        "vision",
        "video",
        "pdf"
      ]
    },
    "gemini-3.1-flash-image-preview": {
      "id": "gemini-3.1-flash-image-preview",
      "name": "Nano Banana 2",
      "contextWindow": 65536,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "high"
        ]
      },
      "capabilities": [
        "vision",
        "pdf"
      ]
    },
    "gemini-3.1-flash-lite": {
      "id": "gemini-3.1-flash-lite",
      "name": "Gemini 3.1 Flash Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.1-flash-lite-image": {
      "id": "gemini-3.1-flash-lite-image",
      "name": "Nano Banana 2 Lite",
      "contextWindow": 65536,
      "maxOutput": 4096,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gemini-3.1-flash-lite-preview": {
      "id": "gemini-3.1-flash-lite-preview",
      "name": "Gemini 3.1 Flash Lite Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.1-flash-live-preview": {
      "id": "gemini-3.1-flash-live-preview",
      "name": "Gemini 3.1 Flash Live Preview",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "gemini-3.1-flash-tts-preview": {
      "id": "gemini-3.1-flash-tts-preview",
      "name": "Gemini 3.1 Flash TTS Preview",
      "contextWindow": 8192,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      }
    },
    "gemini-3.1-pro-preview": {
      "id": "gemini-3.1-pro-preview",
      "name": "Gemini 3.1 Pro Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.1-pro-preview-customtools": {
      "id": "gemini-3.1-pro-preview-customtools",
      "name": "Gemini 3.1 Pro Preview Custom Tools",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.5-flash": {
      "id": "gemini-3.5-flash",
      "name": "Gemini 3.5 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.5-flash-lite": {
      "id": "gemini-3.5-flash-lite",
      "name": "Gemini 3.5 Flash Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.5-live-translate-preview": {
      "id": "gemini-3.5-live-translate-preview",
      "name": "Gemini 3.5 Live Translate Preview",
      "contextWindow": 16384,
      "maxOutput": 32768,
      "capabilities": [
        "audio"
      ]
    },
    "gemini-3.6-flash": {
      "id": "gemini-3.6-flash",
      "name": "Gemini 3.6 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.7-flash": {
      "id": "gemini-3.7-flash",
      "name": "Gemini 3.7 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-3.8-flash": {
      "id": "gemini-3.8-flash",
      "name": "Gemini 3.8 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-embedding-001": {
      "id": "gemini-embedding-001",
      "name": "Gemini Embedding 001",
      "contextWindow": 2048,
      "maxOutput": 1
    },
    "gemini-embedding-2": {
      "id": "gemini-embedding-2",
      "name": "Gemini Embedding 2",
      "contextWindow": 8192,
      "maxOutput": 1,
      "capabilities": [
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-flash-latest": {
      "id": "gemini-flash-latest",
      "name": "Gemini Flash Latest",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-flash-lite-latest": {
      "id": "gemini-flash-lite-latest",
      "name": "Gemini Flash-Lite Latest",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "gemini-omni-flash-preview": {
      "id": "gemini-omni-flash-preview",
      "name": "Gemini Omni Flash Preview",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision",
        "video"
      ]
    },
    "gemma-4-26b-a4b-it": {
      "id": "gemma-4-26b-a4b-it",
      "name": "Gemma 4 26B A4B IT",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "gemma-4-31b-it": {
      "id": "gemma-4-31b-it",
      "name": "Gemma 4 31B IT",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "lyria-3-clip-preview": {
      "id": "lyria-3-clip-preview",
      "name": "Lyria 3 Clip Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "capabilities": [
        "vision"
      ]
    },
    "lyria-3-pro-preview": {
      "id": "lyria-3-pro-preview",
      "name": "Lyria 3 Pro Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "capabilities": [
        "vision"
      ]
    },
    "veo-3.1-fast-generate-preview": {
      "id": "veo-3.1-fast-generate-preview",
      "name": "Veo 3.1 fast",
      "contextWindow": 480,
      "maxOutput": 8192,
      "capabilities": [
        "vision",
        "video"
      ]
    },
    "veo-3.1-generate-preview": {
      "id": "veo-3.1-generate-preview",
      "name": "Veo 3.1",
      "contextWindow": 480,
      "maxOutput": 8192,
      "capabilities": [
        "vision"
      ]
    },
    "veo-3.1-lite-generate-preview": {
      "id": "veo-3.1-lite-generate-preview",
      "name": "Veo 3.1 lite",
      "contextWindow": 480,
      "maxOutput": 8192,
      "capabilities": [
        "vision"
      ]
    }
  },
  "openrouter": {
    "aion-labs/aion-2.0": {
      "id": "aion-labs/aion-2.0",
      "name": "Aion-2.0",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "aion-labs/aion-3.0": {
      "id": "aion-labs/aion-3.0",
      "name": "Aion-3.0",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "aion-labs/aion-3.0-mini": {
      "id": "aion-labs/aion-3.0-mini",
      "name": "Aion-3.0-Mini",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "aion-labs/aion-3.5": {
      "id": "aion-labs/aion-3.5",
      "name": "Aion 3.5",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "aion-labs/aion-3.5-mini": {
      "id": "aion-labs/aion-3.5-mini",
      "name": "Aion 3.5 Mini",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
      "id": "aion-labs/aion-rp-llama-3.1-8b",
      "name": "Aion-RP 1.0 (8B)",
      "contextWindow": 32768,
      "maxOutput": 29491
    },
    "amazon/nova-2-lite-v1": {
      "id": "amazon/nova-2-lite-v1",
      "name": "Nova 2 Lite",
      "contextWindow": 1000000,
      "maxOutput": 65535,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video",
        "pdf"
      ]
    },
    "amazon/nova-lite-v1": {
      "id": "amazon/nova-lite-v1",
      "name": "Nova Lite 1.0",
      "contextWindow": 300000,
      "maxOutput": 5120,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "amazon/nova-micro-v1": {
      "id": "amazon/nova-micro-v1",
      "name": "Nova Micro 1.0",
      "contextWindow": 128000,
      "maxOutput": 5120,
      "capabilities": [
        "tools"
      ]
    },
    "amazon/nova-premier-v1": {
      "id": "amazon/nova-premier-v1",
      "name": "Nova Premier 1.0",
      "contextWindow": 1000000,
      "maxOutput": 32000,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "amazon/nova-pro-v1": {
      "id": "amazon/nova-pro-v1",
      "name": "Nova Pro 1.0",
      "contextWindow": 300000,
      "maxOutput": 5120,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "anthracite-org/magnum-v4-72b": {
      "id": "anthracite-org/magnum-v4-72b",
      "name": "Magnum v4 72B",
      "contextWindow": 32768,
      "maxOutput": 4096
    },
    "anthropic/claude-fable-5": {
      "id": "anthropic/claude-fable-5",
      "name": "Claude Fable 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-fable-5.1": {
      "id": "anthropic/claude-fable-5.1",
      "name": "Claude Fable 5.1",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-haiku-4.5": {
      "id": "anthropic/claude-haiku-4.5",
      "name": "Claude Haiku 4.5 (latest)",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-4.1": {
      "id": "anthropic/claude-opus-4.1",
      "name": "Claude Opus 4.1 (latest)",
      "contextWindow": 200000,
      "maxOutput": 32000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-4.5": {
      "id": "anthropic/claude-opus-4.5",
      "name": "Claude Opus 4.5 (latest)",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-4.6": {
      "id": "anthropic/claude-opus-4.6",
      "name": "Claude Opus 4.6",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-4.7": {
      "id": "anthropic/claude-opus-4.7",
      "name": "Claude Opus 4.7",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-4.8": {
      "id": "anthropic/claude-opus-4.8",
      "name": "Claude Opus 4.8",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-5": {
      "id": "anthropic/claude-opus-5",
      "name": "Claude Opus 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-opus-5.5": {
      "id": "anthropic/claude-opus-5.5",
      "name": "Claude Opus 5.5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-sonnet-4": {
      "id": "anthropic/claude-sonnet-4",
      "name": "Claude Sonnet 4",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-sonnet-4.5": {
      "id": "anthropic/claude-sonnet-4.5",
      "name": "Claude Sonnet 4.5 (latest)",
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-sonnet-4.6": {
      "id": "anthropic/claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-sonnet-5": {
      "id": "anthropic/claude-sonnet-5",
      "name": "Claude Sonnet 5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "anthropic/claude-sonnet-5.5": {
      "id": "anthropic/claude-sonnet-5.5",
      "name": "Claude Sonnet 5.5",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "arcee-ai/trinity-large-thinking": {
      "id": "arcee-ai/trinity-large-thinking",
      "name": "Trinity Large Thinking",
      "contextWindow": 262144,
      "maxOutput": 80000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "baidu/ernie-4.5-vl-424b-a47b": {
      "id": "baidu/ernie-4.5-vl-424b-a47b",
      "name": "ERNIE 4.5 VL 424B A47B ",
      "contextWindow": 123000,
      "maxOutput": 16000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "bytedance-seed/seed-1.6": {
      "id": "bytedance-seed/seed-1.6",
      "name": "Seed 1.6",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "bytedance-seed/seed-1.6-flash": {
      "id": "bytedance-seed/seed-1.6-flash",
      "name": "Seed 1.6 Flash",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "bytedance-seed/seed-2-1-turbo": {
      "id": "bytedance-seed/seed-2-1-turbo",
      "name": "Seed 2.1 Turbo",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "bytedance-seed/seed-2.0-code": {
      "id": "bytedance-seed/seed-2.0-code",
      "name": "Seed 2.0 Code",
      "contextWindow": 262144,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "bytedance-seed/seed-2.0-lite": {
      "id": "bytedance-seed/seed-2.0-lite",
      "name": "Seed 2.0 Lite",
      "contextWindow": 262144,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "bytedance-seed/seed-2.0-mini": {
      "id": "bytedance-seed/seed-2.0-mini",
      "name": "Seed 2.0 Mini",
      "contextWindow": 262144,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "bytedance/ui-tars-1.5-7b": {
      "id": "bytedance/ui-tars-1.5-7b",
      "name": "UI-TARS 7B ",
      "contextWindow": 128000,
      "maxOutput": 2048,
      "capabilities": [
        "vision"
      ]
    },
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
      "id": "cognitivecomputations/dolphin-mistral-24b-venice-edition",
      "name": "Uncensored",
      "contextWindow": 128000,
      "maxOutput": 8192
    },
    "cohere/command-a": {
      "id": "cohere/command-a",
      "name": "Command A",
      "contextWindow": 256000,
      "maxOutput": 8192
    },
    "cohere/command-a-plus": {
      "id": "cohere/command-a-plus",
      "name": "Command A+",
      "contextWindow": 192000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "cohere/command-r-08-2024": {
      "id": "cohere/command-r-08-2024",
      "name": "Command R",
      "contextWindow": 128000,
      "maxOutput": 4000,
      "capabilities": [
        "tools"
      ]
    },
    "cohere/command-r-plus-08-2024": {
      "id": "cohere/command-r-plus-08-2024",
      "name": "Command R+",
      "contextWindow": 128000,
      "maxOutput": 4000,
      "capabilities": [
        "tools"
      ]
    },
    "cohere/command-r7b-12-2024": {
      "id": "cohere/command-r7b-12-2024",
      "name": "Command R7B",
      "contextWindow": 128000,
      "maxOutput": 4000
    },
    "cohere/north-mini-code:free": {
      "id": "cohere/north-mini-code:free",
      "name": "North Mini Code (free)",
      "contextWindow": 256000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-chat": {
      "id": "deepseek/deepseek-chat",
      "name": "DeepSeek Chat",
      "contextWindow": 163840,
      "maxOutput": 16000,
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-chat-v3-0324": {
      "id": "deepseek/deepseek-chat-v3-0324",
      "name": "DeepSeek V3 0324",
      "contextWindow": 163840,
      "maxOutput": 147456,
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-chat-v3.1": {
      "id": "deepseek/deepseek-chat-v3.1",
      "name": "DeepSeek V3.1",
      "contextWindow": 163840,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-r1": {
      "id": "deepseek/deepseek-r1",
      "name": "DeepSeek-R1",
      "contextWindow": 64000,
      "maxOutput": 16000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-r1-0528": {
      "id": "deepseek/deepseek-r1-0528",
      "name": "R1 0528",
      "contextWindow": 163840,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v3.1-terminus": {
      "id": "deepseek/deepseek-v3.1-terminus",
      "name": "DeepSeek V3.1 Terminus",
      "contextWindow": 163840,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v3.2": {
      "id": "deepseek/deepseek-v3.2",
      "name": "DeepSeek V3.2",
      "contextWindow": 163840,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v3.2-exp": {
      "id": "deepseek/deepseek-v3.2-exp",
      "name": "DeepSeek V3.2 Exp",
      "contextWindow": 163840,
      "maxOutput": 147456,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v4-flash": {
      "id": "deepseek/deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v4-flash-0731": {
      "id": "deepseek/deepseek-v4-flash-0731",
      "name": "DeepSeek V4 Flash 0731",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "id": "deepseek/deepseek-v4-flash-vision-exp",
      "name": "DeepSeek V4 Flash Vision Exp",
      "contextWindow": 1048576,
      "maxOutput": 262144,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "deepseek/deepseek-v4-pro": {
      "id": "deepseek/deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "contextWindow": 1048576,
      "maxOutput": 384000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v4-pro-0813": {
      "id": "deepseek/deepseek-v4-pro-0813",
      "name": "DeepSeek V4 Pro 0813",
      "contextWindow": 1048576,
      "maxOutput": 393216,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "deepseek/deepseek-v4.1-flash": {
      "id": "deepseek/deepseek-v4.1-flash",
      "name": "DeepSeek V4.1 Flash",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "dots-studio/dots-3-note-preview:free": {
      "id": "dots-studio/dots-3-note-preview:free",
      "name": "Dots3-Note Preview (free)",
      "contextWindow": 512000,
      "maxOutput": 460800,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "fireworks/ember-1": {
      "id": "fireworks/ember-1",
      "name": "Ember-1",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "google/gemini-2.5-flash": {
      "id": "google/gemini-2.5-flash",
      "name": "Gemini 2.5 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65535,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-2.5-flash-image": {
      "id": "google/gemini-2.5-flash-image",
      "name": "Nano Banana",
      "contextWindow": 32768,
      "maxOutput": 8192,
      "capabilities": [
        "vision"
      ]
    },
    "google/gemini-2.5-flash-lite": {
      "id": "google/gemini-2.5-flash-lite",
      "name": "Gemini 2.5 Flash-Lite",
      "contextWindow": 1048576,
      "maxOutput": 65535,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-2.5-pro": {
      "id": "google/gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 128,
        "max": 32768
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-2.5-pro-preview": {
      "id": "google/gemini-2.5-pro-preview",
      "name": "Gemini 2.5 Pro Preview 06-05",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 128,
        "max": 32768
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "pdf"
      ]
    },
    "google/gemini-3-flash-preview": {
      "id": "google/gemini-3-flash-preview",
      "name": "Gemini 3 Flash Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3-pro-image": {
      "id": "google/gemini-3-pro-image",
      "name": "Nano Banana Pro",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "google/gemini-3-pro-image-preview": {
      "id": "google/gemini-3-pro-image-preview",
      "name": "Nano Banana Pro Preview",
      "contextWindow": 65536,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "google/gemini-3.1-flash-image": {
      "id": "google/gemini-3.1-flash-image",
      "name": "Nano Banana 2",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "high"
        ]
      },
      "capabilities": [
        "vision"
      ]
    },
    "google/gemini-3.1-flash-image-preview": {
      "id": "google/gemini-3.1-flash-image-preview",
      "name": "Nano Banana 2 Preview",
      "contextWindow": 65536,
      "maxOutput": 58982,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "high"
        ]
      },
      "capabilities": [
        "vision"
      ]
    },
    "google/gemini-3.1-flash-lite": {
      "id": "google/gemini-3.1-flash-lite",
      "name": "Gemini 3.1 Flash Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.1-flash-lite-image": {
      "id": "google/gemini-3.1-flash-lite-image",
      "name": "Nano Banana 2 Lite",
      "contextWindow": 65536,
      "maxOutput": 58982,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "high"
        ]
      },
      "capabilities": [
        "vision"
      ]
    },
    "google/gemini-3.1-flash-lite-preview": {
      "id": "google/gemini-3.1-flash-lite-preview",
      "name": "Gemini 3.1 Flash Lite Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.1-pro-preview": {
      "id": "google/gemini-3.1-pro-preview",
      "name": "Gemini 3.1 Pro Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.1-pro-preview-customtools": {
      "id": "google/gemini-3.1-pro-preview-customtools",
      "name": "Gemini 3.1 Pro Preview Custom Tools",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.5-flash": {
      "id": "google/gemini-3.5-flash",
      "name": "Gemini 3.5 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.5-flash-lite": {
      "id": "google/gemini-3.5-flash-lite",
      "name": "Gemini 3.5 Flash Lite",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.6-flash": {
      "id": "google/gemini-3.6-flash",
      "name": "Gemini 3.6 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.7-flash": {
      "id": "google/gemini-3.7-flash",
      "name": "Gemini 3.7 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemini-3.8-flash": {
      "id": "google/gemini-3.8-flash",
      "name": "Gemini 3.8 Flash",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "google/gemma-2-27b-it": {
      "id": "google/gemma-2-27b-it",
      "name": "Gemma 2 27B",
      "contextWindow": 8192,
      "maxOutput": 2048
    },
    "google/gemma-3-12b-it": {
      "id": "google/gemma-3-12b-it",
      "name": "Gemma 3 12B IT",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "google/gemma-3-27b-it": {
      "id": "google/gemma-3-27b-it",
      "name": "Gemma 3 27B IT",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "google/gemma-3-4b-it": {
      "id": "google/gemma-3-4b-it",
      "name": "Gemma 3 4B IT",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "capabilities": [
        "vision"
      ]
    },
    "google/gemma-4-26b-a4b-it": {
      "id": "google/gemma-4-26b-a4b-it",
      "name": "Gemma 4 26B A4B IT",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "google/gemma-4-26b-a4b-it:free": {
      "id": "google/gemma-4-26b-a4b-it:free",
      "name": "Gemma 4 26B A4B  (free)",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "google/gemma-4-31b-it": {
      "id": "google/gemma-4-31b-it",
      "name": "Gemma 4 31B IT",
      "contextWindow": 262144,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "google/gemma-4-31b-it:free": {
      "id": "google/gemma-4-31b-it:free",
      "name": "Gemma 4 31B (free)",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "google/lyria-3-clip-preview": {
      "id": "google/lyria-3-clip-preview",
      "name": "Lyria 3 Clip Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "capabilities": [
        "vision"
      ]
    },
    "google/lyria-3-pro-preview": {
      "id": "google/lyria-3-pro-preview",
      "name": "Lyria 3 Pro Preview",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "capabilities": [
        "vision"
      ]
    },
    "gryphe/mythomax-l2-13b": {
      "id": "gryphe/mythomax-l2-13b",
      "name": "MythoMax 13B",
      "contextWindow": 8192,
      "maxOutput": 3686
    },
    "ibm-granite/granite-4.0-h-micro": {
      "id": "ibm-granite/granite-4.0-h-micro",
      "name": "Granite 4.0 Micro",
      "contextWindow": 131000,
      "maxOutput": 117900
    },
    "ibm-granite/granite-4.2-8b": {
      "id": "ibm-granite/granite-4.2-8b",
      "name": "Granite 4.2 8B",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "inception/mercury-2": {
      "id": "inception/mercury-2",
      "name": "Mercury 2",
      "contextWindow": 128000,
      "maxOutput": 50000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "inception/mercury-2.5": {
      "id": "inception/mercury-2.5",
      "name": "Mercury 2.5",
      "contextWindow": 260000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "inclusionai/ling-3.0-flash": {
      "id": "inclusionai/ling-3.0-flash",
      "name": "Ling 3.0 Flash",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "inclusionai/ling-3.0-flash-fin": {
      "id": "inclusionai/ling-3.0-flash-fin",
      "name": "Ling 3.0 Flash Fin",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "inclusionai/ling-3.0-flash-sante:free": {
      "id": "inclusionai/ling-3.0-flash-sante:free",
      "name": "Ling 3.0 Flash Sante (free)",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "inclusionai/ling-3.0-flash-vl": {
      "id": "inclusionai/ling-3.0-flash-vl",
      "name": "Ling 3.0 Flash VL",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "inference-net/schematron-v2-small": {
      "id": "inference-net/schematron-v2-small",
      "name": "Schematron V2 Small",
      "contextWindow": 128000,
      "maxOutput": 4096
    },
    "inference-net/schematron-v2-turbo": {
      "id": "inference-net/schematron-v2-turbo",
      "name": "Schematron V2 Turbo",
      "contextWindow": 128000,
      "maxOutput": 8192
    },
    "kwaipilot/kat-coder-pro-v2.5": {
      "id": "kwaipilot/kat-coder-pro-v2.5",
      "name": "KAT-Coder-Pro V2.5",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "capabilities": [
        "tools"
      ]
    },
    "liquid/lfm-2.5-2.6b:free": {
      "id": "liquid/lfm-2.5-2.6b:free",
      "name": "LFM2.5-2.6B (free)",
      "contextWindow": 65536,
      "maxOutput": 8192,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "mancer/weaver": {
      "id": "mancer/weaver",
      "name": "Weaver (alpha)",
      "contextWindow": 8000,
      "maxOutput": 6000
    },
    "meituan/longcat-2.0": {
      "id": "meituan/longcat-2.0",
      "name": "LongCat 2.0",
      "contextWindow": 1048756,
      "maxOutput": 262144,
      "reasoning": {
        "kind": "budget",
        "min": 0,
        "max": 0
      },
      "capabilities": [
        "tools"
      ]
    },
    "meta-llama/llama-3.1-70b-instruct": {
      "id": "meta-llama/llama-3.1-70b-instruct",
      "name": "Llama-3.1-70B-Instruct",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "capabilities": [
        "tools"
      ]
    },
    "meta-llama/llama-3.1-8b-instruct": {
      "id": "meta-llama/llama-3.1-8b-instruct",
      "name": "Llama-3.1-8B-Instruct",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "capabilities": [
        "tools"
      ]
    },
    "meta-llama/llama-3.2-1b-instruct": {
      "id": "meta-llama/llama-3.2-1b-instruct",
      "name": "Llama 3.2 1B Instruct",
      "contextWindow": 60000,
      "maxOutput": 54000
    },
    "meta-llama/llama-3.2-3b-instruct": {
      "id": "meta-llama/llama-3.2-3b-instruct",
      "name": "Llama 3.2 3B Instruct",
      "contextWindow": 131072,
      "maxOutput": 117964
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "id": "meta-llama/llama-3.3-70b-instruct",
      "name": "Llama-3.3-70B-Instruct",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "capabilities": [
        "tools"
      ]
    },
    "meta-llama/llama-4-maverick": {
      "id": "meta-llama/llama-4-maverick",
      "name": "Llama 4 Maverick",
      "contextWindow": 1048576,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "meta-llama/llama-4-scout": {
      "id": "meta-llama/llama-4-scout",
      "name": "Llama 4 Scout",
      "contextWindow": 1310720,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "meta-llama/llama-guard-4-12b": {
      "id": "meta-llama/llama-guard-4-12b",
      "name": "Llama Guard 4 12B",
      "contextWindow": 163840,
      "maxOutput": 16384,
      "capabilities": [
        "vision"
      ]
    },
    "meta/muse-glimmer-30b": {
      "id": "meta/muse-glimmer-30b",
      "name": "Muse Glimmer 30B",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "meta/muse-spark-1.1": {
      "id": "meta/muse-spark-1.1",
      "name": "Muse Spark 1.1",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video",
        "pdf"
      ]
    },
    "meta/muse-spark-1.2": {
      "id": "meta/muse-spark-1.2",
      "name": "Muse Spark 1.2",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video",
        "pdf"
      ]
    },
    "meta/muse-spark-1.2-contributor": {
      "id": "meta/muse-spark-1.2-contributor",
      "name": "Muse Spark 1.2 Contributor",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video",
        "pdf"
      ]
    },
    "meta/muse-spark-1.3": {
      "id": "meta/muse-spark-1.3",
      "name": "Muse Spark 1.3",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video",
        "pdf"
      ]
    },
    "meta/muse-spark-1.3-contributor": {
      "id": "meta/muse-spark-1.3-contributor",
      "name": "Muse Spark 1.3 Contributor",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video",
        "pdf"
      ]
    },
    "microsoft/phi-4": {
      "id": "microsoft/phi-4",
      "name": "Phi 4",
      "contextWindow": 16384,
      "maxOutput": 14745
    },
    "microsoft/wizardlm-2-8x22b": {
      "id": "microsoft/wizardlm-2-8x22b",
      "name": "WizardLM-2 8x22B",
      "contextWindow": 65535,
      "maxOutput": 8000
    },
    "minimax/minimax-01": {
      "id": "minimax/minimax-01",
      "name": "MiniMax-01",
      "contextWindow": 1000192,
      "maxOutput": 40000,
      "capabilities": [
        "vision"
      ]
    },
    "minimax/minimax-m1": {
      "id": "minimax/minimax-m1",
      "name": "MiniMax M1",
      "contextWindow": 1000000,
      "maxOutput": 40000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "minimax/minimax-m2": {
      "id": "minimax/minimax-m2",
      "name": "MiniMax-M2",
      "contextWindow": 204800,
      "maxOutput": 176947,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "minimax/minimax-m2-her": {
      "id": "minimax/minimax-m2-her",
      "name": "MiniMax-M2 Her",
      "contextWindow": 65536,
      "maxOutput": 2048
    },
    "minimax/minimax-m2.1": {
      "id": "minimax/minimax-m2.1",
      "name": "MiniMax-M2.1",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "minimax/minimax-m2.5": {
      "id": "minimax/minimax-m2.5",
      "name": "MiniMax-M2.5",
      "contextWindow": 204800,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "minimax/minimax-m2.7": {
      "id": "minimax/minimax-m2.7",
      "name": "MiniMax-M2.7",
      "contextWindow": 204800,
      "maxOutput": 176947,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "minimax/minimax-m3": {
      "id": "minimax/minimax-m3",
      "name": "MiniMax-M3",
      "contextWindow": 1048576,
      "maxOutput": 512000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "mistralai/codestral-2508": {
      "id": "mistralai/codestral-2508",
      "name": "Codestral 2508",
      "contextWindow": 256000,
      "maxOutput": 204800,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/devstral-2512": {
      "id": "mistralai/devstral-2512",
      "name": "Devstral 2",
      "contextWindow": 262144,
      "maxOutput": 209715,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/ministral-14b-2512": {
      "id": "mistralai/ministral-14b-2512",
      "name": "Ministral 3 14B 2512",
      "contextWindow": 262144,
      "maxOutput": 209715,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "mistralai/ministral-3b-2512": {
      "id": "mistralai/ministral-3b-2512",
      "name": "Ministral 3 3B 2512",
      "contextWindow": 131072,
      "maxOutput": 104857,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "mistralai/ministral-8b-2512": {
      "id": "mistralai/ministral-8b-2512",
      "name": "Ministral 3 8B 2512",
      "contextWindow": 262144,
      "maxOutput": 209715,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "mistralai/mistral-large": {
      "id": "mistralai/mistral-large",
      "name": "Mistral Large",
      "contextWindow": 128000,
      "maxOutput": 102400,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-large-2407": {
      "id": "mistralai/mistral-large-2407",
      "name": "Mistral Large 2407",
      "contextWindow": 131072,
      "maxOutput": 104857,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-large-2512": {
      "id": "mistralai/mistral-large-2512",
      "name": "Mistral Large 3",
      "contextWindow": 262144,
      "maxOutput": 209715,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-medium-3": {
      "id": "mistralai/mistral-medium-3",
      "name": "Mistral Medium 3",
      "contextWindow": 131072,
      "maxOutput": 104857,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-medium-3-5": {
      "id": "mistralai/mistral-medium-3-5",
      "name": "Mistral Medium 3.5",
      "contextWindow": 262144,
      "maxOutput": 209715,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-medium-3.1": {
      "id": "mistralai/mistral-medium-3.1",
      "name": "Mistral Medium 3.1",
      "contextWindow": 131072,
      "maxOutput": 104857,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-nemo": {
      "id": "mistralai/mistral-nemo",
      "name": "Mistral Nemo",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "capabilities": [
        "tools"
      ]
    },
    "mistralai/mistral-saba": {
      "id": "mistralai/mistral-saba",
      "name": "Saba",
      "contextWindow": 32768,
      "maxOutput": 26214,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/mistral-small-24b-instruct-2501": {
      "id": "mistralai/mistral-small-24b-instruct-2501",
      "name": "Mistral Small 3",
      "contextWindow": 32768,
      "maxOutput": 16384
    },
    "mistralai/mistral-small-2603": {
      "id": "mistralai/mistral-small-2603",
      "name": "Mistral Small 4",
      "contextWindow": 262144,
      "maxOutput": 209715,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
      "id": "mistralai/mistral-small-3.1-24b-instruct",
      "name": "Mistral Small 3.1 24B",
      "contextWindow": 128000,
      "maxOutput": 102400,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
      "id": "mistralai/mistral-small-3.2-24b-instruct",
      "name": "Mistral Small 3.2 24B",
      "contextWindow": 256000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "mistralai/mixtral-8x22b-instruct": {
      "id": "mistralai/mixtral-8x22b-instruct",
      "name": "Mixtral 8x22B Instruct",
      "contextWindow": 65536,
      "maxOutput": 52428,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "mistralai/voxtral-small-24b-2507": {
      "id": "mistralai/voxtral-small-24b-2507",
      "name": "Voxtral Small 24B 2507",
      "contextWindow": 32768,
      "maxOutput": 26214,
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "pdf"
      ]
    },
    "moonshotai/kimi-k2": {
      "id": "moonshotai/kimi-k2",
      "name": "Kimi K2 0711",
      "contextWindow": 131072,
      "maxOutput": 98304,
      "capabilities": [
        "tools"
      ]
    },
    "moonshotai/kimi-k2-0905": {
      "id": "moonshotai/kimi-k2-0905",
      "name": "Kimi K2 0905",
      "contextWindow": 262144,
      "maxOutput": 98304,
      "capabilities": [
        "tools"
      ]
    },
    "moonshotai/kimi-k2-thinking": {
      "id": "moonshotai/kimi-k2-thinking",
      "name": "Kimi K2 Thinking",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "moonshotai/kimi-k2.5": {
      "id": "moonshotai/kimi-k2.5",
      "name": "Kimi K2.5",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "moonshotai/kimi-k2.6": {
      "id": "moonshotai/kimi-k2.6",
      "name": "Kimi K2.6",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "moonshotai/kimi-k2.7-code": {
      "id": "moonshotai/kimi-k2.7-code",
      "name": "Kimi K2.7 Code",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "moonshotai/kimi-k3": {
      "id": "moonshotai/kimi-k3",
      "name": "Kimi K3",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "morph/morph-v3-fast": {
      "id": "morph/morph-v3-fast",
      "name": "Morph V3 Fast",
      "contextWindow": 81920,
      "maxOutput": 38000
    },
    "morph/morph-v3-large": {
      "id": "morph/morph-v3-large",
      "name": "Morph V3 Large",
      "contextWindow": 262144,
      "maxOutput": 131072
    },
    "nex-agi/nex-n2.5-mini": {
      "id": "nex-agi/nex-n2.5-mini",
      "name": "Nex-N2.5-Mini",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "vision"
      ]
    },
    "nex-agi/nex-n2.5-pro": {
      "id": "nex-agi/nex-n2.5-pro",
      "name": "Nex-N2.5-Pro",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "nousresearch/hermes-3-llama-3.1-405b": {
      "id": "nousresearch/hermes-3-llama-3.1-405b",
      "name": "Hermes 3 405B Instruct",
      "contextWindow": 131072,
      "maxOutput": 16384
    },
    "nousresearch/hermes-3-llama-3.1-70b": {
      "id": "nousresearch/hermes-3-llama-3.1-70b",
      "name": "Hermes 3 70B Instruct",
      "contextWindow": 131072,
      "maxOutput": 16384
    },
    "nousresearch/hermes-4-405b": {
      "id": "nousresearch/hermes-4-405b",
      "name": "Hermes 4 405B",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "toggle"
      }
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "id": "nvidia/nemotron-3-nano-30b-a3b",
      "name": "Nemotron 3 Nano 30B A3B",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
      "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "name": "Nemotron 3 Nano Omni (free)",
      "contextWindow": 256000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 0,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      "id": "nvidia/nemotron-3-super-120b-a12b",
      "name": "Nemotron 3 Super 120B A12B",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "nvidia/nemotron-3-super-120b-a12b:free": {
      "id": "nvidia/nemotron-3-super-120b-a12b:free",
      "name": "Nemotron 3 Super (free)",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "id": "nvidia/nemotron-3-ultra-550b-a55b",
      "name": "Nemotron 3 Ultra 550B A55B",
      "contextWindow": 262144,
      "maxOutput": 182520,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
      "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
      "name": "Nemotron 3 Ultra (free)",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "nvidia/nemotron-3.5-content-safety": {
      "id": "nvidia/nemotron-3.5-content-safety",
      "name": "Nemotron 3.5 Content Safety",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "nvidia/nemotron-3.5-content-safety:free": {
      "id": "nvidia/nemotron-3.5-content-safety:free",
      "name": "Nemotron 3.5 Content Safety (free)",
      "contextWindow": 128000,
      "maxOutput": 8192,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "nvidia/nemotron-3.5-lightning": {
      "id": "nvidia/nemotron-3.5-lightning",
      "name": "Nemotron 3.5 Lightning 30B A3B",
      "contextWindow": 262144,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "nvidia/nemotron-3.5-lightning:free": {
      "id": "nvidia/nemotron-3.5-lightning:free",
      "name": "Nemotron 3.5 Lightning (free)",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-3.5-turbo": {
      "id": "openai/gpt-3.5-turbo",
      "name": "GPT-3.5-turbo",
      "contextWindow": 16385,
      "maxOutput": 4096,
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-3.5-turbo-0613": {
      "id": "openai/gpt-3.5-turbo-0613",
      "name": "GPT-3.5 Turbo (older v0613)",
      "contextWindow": 4095,
      "maxOutput": 3685,
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-3.5-turbo-16k": {
      "id": "openai/gpt-3.5-turbo-16k",
      "name": "GPT-3.5 Turbo 16k",
      "contextWindow": 16385,
      "maxOutput": 4096,
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-3.5-turbo-instruct": {
      "id": "openai/gpt-3.5-turbo-instruct",
      "name": "GPT-3.5 Turbo Instruct",
      "contextWindow": 4095,
      "maxOutput": 3685
    },
    "openai/gpt-4": {
      "id": "openai/gpt-4",
      "name": "GPT-4",
      "contextWindow": 8191,
      "maxOutput": 4096,
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-4-turbo": {
      "id": "openai/gpt-4-turbo",
      "name": "GPT-4 Turbo",
      "contextWindow": 128000,
      "maxOutput": 4096,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "openai/gpt-4.1": {
      "id": "openai/gpt-4.1",
      "name": "GPT-4.1",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4.1-mini": {
      "id": "openai/gpt-4.1-mini",
      "name": "GPT-4.1 mini",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4.1-nano": {
      "id": "openai/gpt-4.1-nano",
      "name": "GPT-4.1 nano",
      "contextWindow": 1047576,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4o": {
      "id": "openai/gpt-4o",
      "name": "GPT-4o",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4o-2024-05-13": {
      "id": "openai/gpt-4o-2024-05-13",
      "name": "GPT-4o (2024-05-13)",
      "contextWindow": 128000,
      "maxOutput": 4096,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4o-2024-08-06": {
      "id": "openai/gpt-4o-2024-08-06",
      "name": "GPT-4o (2024-08-06)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4o-2024-11-20": {
      "id": "openai/gpt-4o-2024-11-20",
      "name": "GPT-4o (2024-11-20)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4o-mini": {
      "id": "openai/gpt-4o-mini",
      "name": "GPT-4o mini",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-4o-mini-2024-07-18": {
      "id": "openai/gpt-4o-mini-2024-07-18",
      "name": "GPT-4o-mini (2024-07-18)",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5": {
      "id": "openai/gpt-5",
      "name": "GPT-5",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5-image": {
      "id": "openai/gpt-5-image",
      "name": "GPT-5 Image",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5-image-mini": {
      "id": "openai/gpt-5-image-mini",
      "name": "GPT-5 Image Mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5-mini": {
      "id": "openai/gpt-5-mini",
      "name": "GPT-5 Mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5-nano": {
      "id": "openai/gpt-5-nano",
      "name": "GPT-5 Nano",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5-pro": {
      "id": "openai/gpt-5-pro",
      "name": "GPT-5 Pro",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.1": {
      "id": "openai/gpt-5.1",
      "name": "GPT-5.1",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.1-codex": {
      "id": "openai/gpt-5.1-codex",
      "name": "GPT-5.1 Codex",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "openai/gpt-5.1-codex-max": {
      "id": "openai/gpt-5.1-codex-max",
      "name": "GPT-5.1 Codex Max",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "openai/gpt-5.1-codex-mini": {
      "id": "openai/gpt-5.1-codex-mini",
      "name": "GPT-5.1 Codex mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "openai/gpt-5.2": {
      "id": "openai/gpt-5.2",
      "name": "GPT-5.2",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.2-chat": {
      "id": "openai/gpt-5.2-chat",
      "name": "GPT-5.2 Chat",
      "contextWindow": 128000,
      "maxOutput": 32000,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.2-codex": {
      "id": "openai/gpt-5.2-codex",
      "name": "GPT-5.2 Codex",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "openai/gpt-5.2-pro": {
      "id": "openai/gpt-5.2-pro",
      "name": "GPT-5.2 Pro",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.3-codex": {
      "id": "openai/gpt-5.3-codex",
      "name": "GPT-5.3 Codex",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.4": {
      "id": "openai/gpt-5.4",
      "name": "GPT-5.4",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.4-image-2": {
      "id": "openai/gpt-5.4-image-2",
      "name": "GPT-5.4 Image 2",
      "contextWindow": 272000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.4-mini": {
      "id": "openai/gpt-5.4-mini",
      "name": "GPT-5.4 mini",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.4-nano": {
      "id": "openai/gpt-5.4-nano",
      "name": "GPT-5.4 nano",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.4-pro": {
      "id": "openai/gpt-5.4-pro",
      "name": "GPT-5.4 Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.5": {
      "id": "openai/gpt-5.5",
      "name": "GPT-5.5",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.5-pro": {
      "id": "openai/gpt-5.5-pro",
      "name": "GPT-5.5 Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.6-luna": {
      "id": "openai/gpt-5.6-luna",
      "name": "GPT-5.6 Luna",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.6-luna-pro": {
      "id": "openai/gpt-5.6-luna-pro",
      "name": "GPT-5.6 Luna Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.6-sol": {
      "id": "openai/gpt-5.6-sol",
      "name": "GPT-5.6 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.6-sol-pro": {
      "id": "openai/gpt-5.6-sol-pro",
      "name": "GPT-5.6 Sol Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.6-terra": {
      "id": "openai/gpt-5.6-terra",
      "name": "GPT-5.6 Terra",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-5.6-terra-pro": {
      "id": "openai/gpt-5.6-terra-pro",
      "name": "GPT-5.6 Terra Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6-astra": {
      "id": "openai/gpt-6-astra",
      "name": "GPT-6 Astra",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6-astra-pro": {
      "id": "openai/gpt-6-astra-pro",
      "name": "GPT-6 Astra Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6-luna": {
      "id": "openai/gpt-6-luna",
      "name": "GPT-6 Luna",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6-luna-pro": {
      "id": "openai/gpt-6-luna-pro",
      "name": "GPT-6 Luna Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6-sol": {
      "id": "openai/gpt-6-sol",
      "name": "GPT-6 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6-sol-pro": {
      "id": "openai/gpt-6-sol-pro",
      "name": "GPT-6 Sol Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6.1-sol": {
      "id": "openai/gpt-6.1-sol",
      "name": "GPT-6.1 Sol",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-6.1-sol-pro": {
      "id": "openai/gpt-6.1-sol-pro",
      "name": "GPT-6.1 Sol Pro",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-audio": {
      "id": "openai/gpt-audio",
      "name": "GPT Audio",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "openai/gpt-audio-mini": {
      "id": "openai/gpt-audio-mini",
      "name": "GPT Audio Mini",
      "contextWindow": 128000,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "openai/gpt-chat-latest": {
      "id": "openai/gpt-chat-latest",
      "name": "GPT Chat Latest",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/gpt-oss-120b": {
      "id": "openai/gpt-oss-120b",
      "name": "GPT OSS 120B",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-oss-20b": {
      "id": "openai/gpt-oss-20b",
      "name": "GPT OSS 20B",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-oss-safeguard-20b": {
      "id": "openai/gpt-oss-safeguard-20b",
      "name": "GPT OSS Safeguard 20B",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "openai/o1": {
      "id": "openai/o1",
      "name": "o1",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/o1-pro": {
      "id": "openai/o1-pro",
      "name": "o1-pro",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision",
        "pdf"
      ]
    },
    "openai/o3": {
      "id": "openai/o3",
      "name": "o3",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/o3-mini": {
      "id": "openai/o3-mini",
      "name": "o3-mini",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/o3-mini-high": {
      "id": "openai/o3-mini-high",
      "name": "o3 Mini High",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/o3-pro": {
      "id": "openai/o3-pro",
      "name": "o3-pro",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/o4-mini": {
      "id": "openai/o4-mini",
      "name": "o4-mini",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openai/o4-mini-high": {
      "id": "openai/o4-mini-high",
      "name": "o4 Mini High",
      "contextWindow": 200000,
      "maxOutput": 100000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "openrouter/auto": {
      "id": "openrouter/auto",
      "name": "Auto Router",
      "contextWindow": 2000000,
      "maxOutput": 2000000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "openrouter/bodybuilder": {
      "id": "openrouter/bodybuilder",
      "name": "Body Builder (beta)",
      "contextWindow": 128000,
      "maxOutput": 128000
    },
    "openrouter/free": {
      "id": "openrouter/free",
      "name": "Free Models Router",
      "contextWindow": 200000,
      "maxOutput": 8000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "openrouter/fusion": {
      "id": "openrouter/fusion",
      "name": "Fusion",
      "contextWindow": 1000000,
      "maxOutput": 128000
    },
    "openrouter/pareto-code": {
      "id": "openrouter/pareto-code",
      "name": "Pareto Code Router",
      "contextWindow": 2000000,
      "maxOutput": 200000
    },
    "perceptron/perceptron-mk1": {
      "id": "perceptron/perceptron-mk1",
      "name": "Perceptron Mk1",
      "contextWindow": 32768,
      "maxOutput": 8192,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision",
        "video"
      ]
    },
    "perceptron/perceptron-mk1.5": {
      "id": "perceptron/perceptron-mk1.5",
      "name": "Perceptron Mk1.5",
      "contextWindow": 36864,
      "maxOutput": 8192,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "perplexity/sonar": {
      "id": "perplexity/sonar",
      "name": "Sonar",
      "contextWindow": 127072,
      "maxOutput": 114364,
      "capabilities": [
        "vision"
      ]
    },
    "perplexity/sonar-deep-research": {
      "id": "perplexity/sonar-deep-research",
      "name": "Sonar Deep Research",
      "contextWindow": 128000,
      "maxOutput": 115200,
      "reasoning": {
        "kind": "toggle"
      }
    },
    "perplexity/sonar-pro": {
      "id": "perplexity/sonar-pro",
      "name": "Sonar Pro",
      "contextWindow": 200000,
      "maxOutput": 8000,
      "capabilities": [
        "vision"
      ]
    },
    "perplexity/sonar-pro-search": {
      "id": "perplexity/sonar-pro-search",
      "name": "Sonar Pro Search",
      "contextWindow": 200000,
      "maxOutput": 8000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "perplexity/sonar-reasoning-pro": {
      "id": "perplexity/sonar-reasoning-pro",
      "name": "Sonar Reasoning Pro",
      "contextWindow": 128000,
      "maxOutput": 115200,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "vision"
      ]
    },
    "poolside/laguna-s-2.1": {
      "id": "poolside/laguna-s-2.1",
      "name": "Laguna S 2.1",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "poolside/laguna-s-2.1:free": {
      "id": "poolside/laguna-s-2.1:free",
      "name": "Laguna S 2.1 (free)",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "poolside/laguna-xs-2.1": {
      "id": "poolside/laguna-xs-2.1",
      "name": "Laguna XS 2.1",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "poolside/laguna-xs-2.1:free": {
      "id": "poolside/laguna-xs-2.1:free",
      "name": "Laguna XS 2.1 (free)",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "prism-ml/ternary-bonsai-2-27b": {
      "id": "prism-ml/ternary-bonsai-2-27b",
      "name": "Ternary Bonsai 2 27B",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "medium",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen-2.5-72b-instruct": {
      "id": "qwen/qwen-2.5-72b-instruct",
      "name": "Qwen2.5 72B Instruct",
      "contextWindow": 32768,
      "maxOutput": 16384,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen-2.5-7b-instruct": {
      "id": "qwen/qwen-2.5-7b-instruct",
      "name": "Qwen2.5 7B Instruct",
      "contextWindow": 32768,
      "maxOutput": 29491,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen-2.5-coder-32b-instruct": {
      "id": "qwen/qwen-2.5-coder-32b-instruct",
      "name": "Qwen2.5 Coder 32B Instruct",
      "contextWindow": 32768,
      "maxOutput": 29491
    },
    "qwen/qwen-plus": {
      "id": "qwen/qwen-plus",
      "name": "Qwen Plus",
      "contextWindow": 1000000,
      "maxOutput": 32768,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen-plus-2025-07-28": {
      "id": "qwen/qwen-plus-2025-07-28",
      "name": "Qwen Plus 0728",
      "contextWindow": 1000000,
      "maxOutput": 32768,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen2.5-vl-72b-instruct": {
      "id": "qwen/qwen2.5-vl-72b-instruct",
      "name": "Qwen2.5 VL 72B Instruct",
      "contextWindow": 128000,
      "maxOutput": 115200,
      "capabilities": [
        "vision"
      ]
    },
    "qwen/qwen3-14b": {
      "id": "qwen/qwen3-14b",
      "name": "Qwen3 14B",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-235b-a22b": {
      "id": "qwen/qwen3-235b-a22b",
      "name": "Qwen3 235B-A22B",
      "contextWindow": 131072,
      "maxOutput": 8192,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-235b-a22b-2507": {
      "id": "qwen/qwen3-235b-a22b-2507",
      "name": "Qwen3 235B A22B Instruct 2507",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
      "id": "qwen/qwen3-235b-a22b-thinking-2507",
      "name": "Qwen3 235B A22B Thinking 2507",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-30b-a3b": {
      "id": "qwen/qwen3-30b-a3b",
      "name": "Qwen3 30B A3B",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
      "id": "qwen/qwen3-30b-a3b-instruct-2507",
      "name": "Qwen3 30B A3B Instruct 2507",
      "contextWindow": 262144,
      "maxOutput": 32000,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-30b-a3b-thinking-2507": {
      "id": "qwen/qwen3-30b-a3b-thinking-2507",
      "name": "Qwen3 30B A3B Thinking 2507",
      "contextWindow": 81920,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-32b": {
      "id": "qwen/qwen3-32b",
      "name": "Qwen3 32B",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-8b": {
      "id": "qwen/qwen3-8b",
      "name": "Qwen3 8B",
      "contextWindow": 131072,
      "maxOutput": 8192,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-coder": {
      "id": "qwen/qwen3-coder",
      "name": "Qwen3 Coder 480B A35B",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
      "id": "qwen/qwen3-coder-30b-a3b-instruct",
      "name": "Qwen3-Coder 30B-A3B Instruct",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-coder-flash": {
      "id": "qwen/qwen3-coder-flash",
      "name": "Qwen3 Coder Flash",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-coder-next": {
      "id": "qwen/qwen3-coder-next",
      "name": "Qwen3 Coder Next",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-coder-plus": {
      "id": "qwen/qwen3-coder-plus",
      "name": "Qwen3 Coder Plus",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-max": {
      "id": "qwen/qwen3-max",
      "name": "Qwen3 Max",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-max-thinking": {
      "id": "qwen/qwen3-max-thinking",
      "name": "Qwen3 Max Thinking",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "id": "qwen/qwen3-next-80b-a3b-instruct",
      "name": "Qwen3-Next 80B-A3B Instruct",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
      "id": "qwen/qwen3-next-80b-a3b-thinking",
      "name": "Qwen3-Next 80B-A3B (Thinking)",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
      "id": "qwen/qwen3-vl-235b-a22b-instruct",
      "name": "Qwen3 VL 235B A22B Instruct",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
      "id": "qwen/qwen3-vl-235b-a22b-thinking",
      "name": "Qwen3 VL 235B A22B Thinking",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
      "id": "qwen/qwen3-vl-30b-a3b-instruct",
      "name": "Qwen3 VL 30B A3B Instruct",
      "contextWindow": 262144,
      "maxOutput": 16384,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3-vl-30b-a3b-thinking": {
      "id": "qwen/qwen3-vl-30b-a3b-thinking",
      "name": "Qwen3 VL 30B A3B Thinking",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3-vl-32b-instruct": {
      "id": "qwen/qwen3-vl-32b-instruct",
      "name": "Qwen3 VL 32B Instruct",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3-vl-8b-instruct": {
      "id": "qwen/qwen3-vl-8b-instruct",
      "name": "Qwen3 VL 8B Instruct",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3-vl-8b-thinking": {
      "id": "qwen/qwen3-vl-8b-thinking",
      "name": "Qwen3 VL 8B Thinking",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3.5-122b-a10b": {
      "id": "qwen/qwen3.5-122b-a10b",
      "name": "Qwen3.5 122B-A10B",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-27b": {
      "id": "qwen/qwen3.5-27b",
      "name": "Qwen3.5 27B",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-35b-a3b": {
      "id": "qwen/qwen3.5-35b-a3b",
      "name": "Qwen3.5 35B-A3B",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-397b-a17b": {
      "id": "qwen/qwen3.5-397b-a17b",
      "name": "Qwen3.5 397B-A17B",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-9b": {
      "id": "qwen/qwen3.5-9b",
      "name": "Qwen3.5 9B",
      "contextWindow": 262144,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-flash-02-23": {
      "id": "qwen/qwen3.5-flash-02-23",
      "name": "Qwen3.5-Flash",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-plus-02-15": {
      "id": "qwen/qwen3.5-plus-02-15",
      "name": "Qwen3.5 Plus 2026-02-15",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.5-plus-20260420": {
      "id": "qwen/qwen3.5-plus-20260420",
      "name": "Qwen3.5 Plus 2026-04-20",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.6-27b": {
      "id": "qwen/qwen3.6-27b",
      "name": "Qwen3.6 27B",
      "contextWindow": 262144,
      "maxOutput": 81920,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.6-35b-a3b": {
      "id": "qwen/qwen3.6-35b-a3b",
      "name": "Qwen3.6 35B-A3B",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.6-flash": {
      "id": "qwen/qwen3.6-flash",
      "name": "Qwen3.6 Flash",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.6-max-preview": {
      "id": "qwen/qwen3.6-max-preview",
      "name": "Qwen3.6 Max Preview",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3.6-plus": {
      "id": "qwen/qwen3.6-plus",
      "name": "Qwen3.6 Plus",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.7-flash": {
      "id": "qwen/qwen3.7-flash",
      "name": "Qwen3.7 Flash",
      "contextWindow": 1000000,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "budget",
        "min": 0,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.7-max": {
      "id": "qwen/qwen3.7-max",
      "name": "Qwen3.7 Max",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3.7-plus": {
      "id": "qwen/qwen3.7-plus",
      "name": "Qwen3.7 Plus",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3.8-2.4t-a95b": {
      "id": "qwen/qwen3.8-2.4t-a95b",
      "name": "Qwen3.8 2.4T A95B",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3.8-27b": {
      "id": "qwen/qwen3.8-27b",
      "name": "Qwen3.8 27B",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.8-27b:free": {
      "id": "qwen/qwen3.8-27b:free",
      "name": "Qwen3.8 27B (free)",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.8-flash": {
      "id": "qwen/qwen3.8-flash",
      "name": "Qwen3.8 Flash",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "budget",
        "min": 0,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.8-max-0902": {
      "id": "qwen/qwen3.8-max-0902",
      "name": "Qwen3.8 Max 0902",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.8-max-prime": {
      "id": "qwen/qwen3.8-max-prime",
      "name": "Qwen 3.8 Max Prime",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "qwen/qwen3.8-omni-flash": {
      "id": "qwen/qwen3.8-omni-flash",
      "name": "Qwen3.8 Omni Flash",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "budget",
        "min": 0,
        "max": 0
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "rekaai/reka-edge": {
      "id": "rekaai/reka-edge",
      "name": "Reka Edge",
      "contextWindow": 16384,
      "maxOutput": 14745,
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "rekaai/reka-flash-3": {
      "id": "rekaai/reka-flash-3",
      "name": "Reka Flash 3",
      "contextWindow": 65536,
      "maxOutput": 58982,
      "reasoning": {
        "kind": "toggle"
      }
    },
    "relace/relace-apply-3": {
      "id": "relace/relace-apply-3",
      "name": "Relace Apply 3",
      "contextWindow": 256000,
      "maxOutput": 128000
    },
    "relace/relace-search": {
      "id": "relace/relace-search",
      "name": "Relace Search",
      "contextWindow": 256000,
      "maxOutput": 128000,
      "capabilities": [
        "tools"
      ]
    },
    "sakana/fugu-max": {
      "id": "sakana/fugu-max",
      "name": "Fugu Max",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "sakana/fugu-ultra": {
      "id": "sakana/fugu-ultra",
      "name": "Fugu Ultra",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "sakana/fugu-ultra-v2": {
      "id": "sakana/fugu-ultra-v2",
      "name": "Fugu Ultra v2",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "sakana/sakana-namazu": {
      "id": "sakana/sakana-namazu",
      "name": "Sakana Namazu",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "sao10k/l3-lunaris-8b": {
      "id": "sao10k/l3-lunaris-8b",
      "name": "Llama 3 8B Lunaris",
      "contextWindow": 8192,
      "maxOutput": 7372
    },
    "sao10k/l3.1-euryale-70b": {
      "id": "sao10k/l3.1-euryale-70b",
      "name": "Llama 3.1 Euryale 70B v2.2",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "capabilities": [
        "tools"
      ]
    },
    "sao10k/l3.3-euryale-70b": {
      "id": "sao10k/l3.3-euryale-70b",
      "name": "Llama 3.3 Euryale 70B",
      "contextWindow": 131072,
      "maxOutput": 16384
    },
    "stealth/space-bunny-alpha": {
      "id": "stealth/space-bunny-alpha",
      "name": "Space Bunny Alpha",
      "contextWindow": 1000000,
      "maxOutput": 524288,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "stepfun/step-3.5-flash": {
      "id": "stepfun/step-3.5-flash",
      "name": "Step 3.5 Flash",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "stepfun/step-3.7-flash": {
      "id": "stepfun/step-3.7-flash",
      "name": "Step 3.7 Flash",
      "contextWindow": 262144,
      "maxOutput": 230400,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "tencent/hunyuan-a13b-instruct": {
      "id": "tencent/hunyuan-a13b-instruct",
      "name": "Hunyuan A13B Instruct",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "toggle"
      }
    },
    "tencent/hy-mt2-1.8b": {
      "id": "tencent/hy-mt2-1.8b",
      "name": "Hy-MT2-1.8B",
      "contextWindow": 8192,
      "maxOutput": 4096
    },
    "tencent/hy-mt2-30b-a3b": {
      "id": "tencent/hy-mt2-30b-a3b",
      "name": "Hy-MT2-30B-A3B",
      "contextWindow": 8192,
      "maxOutput": 4096
    },
    "tencent/hy-mt2-7b": {
      "id": "tencent/hy-mt2-7b",
      "name": "Hy-MT2-7B",
      "contextWindow": 8192,
      "maxOutput": 4096
    },
    "tencent/hy3": {
      "id": "tencent/hy3",
      "name": "Hy3",
      "contextWindow": 262144,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "tencent/hy3-preview": {
      "id": "tencent/hy3-preview",
      "name": "Hy3 preview",
      "contextWindow": 262144,
      "maxOutput": 235929,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "tencent/hy4-preview": {
      "id": "tencent/hy4-preview",
      "name": "Hy4 preview",
      "contextWindow": 1048576,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "thedrummer/cydonia-24b-v4.1": {
      "id": "thedrummer/cydonia-24b-v4.1",
      "name": "Cydonia 24B V4.1",
      "contextWindow": 131072,
      "maxOutput": 117964
    },
    "thedrummer/skyfall-36b-v2": {
      "id": "thedrummer/skyfall-36b-v2",
      "name": "Skyfall 36B V2",
      "contextWindow": 32768,
      "maxOutput": 29491
    },
    "thedrummer/unslopnemo-12b": {
      "id": "thedrummer/unslopnemo-12b",
      "name": "UnslopNemo 12B",
      "contextWindow": 1024000,
      "maxOutput": 819200
    },
    "thinkingmachines/inkling": {
      "id": "thinkingmachines/inkling",
      "name": "Inkling",
      "contextWindow": 524288,
      "maxOutput": 471859,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "thinkingmachines/inkling-small": {
      "id": "thinkingmachines/inkling-small",
      "name": "Inkling Small",
      "contextWindow": 524288,
      "maxOutput": 262144,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "thinkingmachines/inkling-small:free": {
      "id": "thinkingmachines/inkling-small:free",
      "name": "Inkling Small (free)",
      "contextWindow": 1048576,
      "maxOutput": 262144,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "thinkingmachines/inkling:free": {
      "id": "thinkingmachines/inkling:free",
      "name": "Inkling (free)",
      "contextWindow": 1048576,
      "maxOutput": 262144,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio"
      ]
    },
    "unbiased/pareto": {
      "id": "unbiased/pareto",
      "name": "Pareto",
      "contextWindow": 262144,
      "maxOutput": 131072,
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "undi95/remm-slerp-l2-13b": {
      "id": "undi95/remm-slerp-l2-13b",
      "name": "ReMM SLERP 13B",
      "contextWindow": 6144,
      "maxOutput": 5529
    },
    "upstage/solar-mini4": {
      "id": "upstage/solar-mini4",
      "name": "Solar Mini 4",
      "contextWindow": 524288,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "upstage/solar-pro-3": {
      "id": "upstage/solar-pro-3",
      "name": "Solar Pro 3",
      "contextWindow": 131072,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "upstage/solar-pro4": {
      "id": "upstage/solar-pro4",
      "name": "Solar Pro 4",
      "contextWindow": 524288,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "writer/palmyra-x5": {
      "id": "writer/palmyra-x5",
      "name": "Palmyra X5",
      "contextWindow": 1040000,
      "maxOutput": 8192
    },
    "x-ai/grok-4.20": {
      "id": "x-ai/grok-4.20",
      "name": "Grok 4.20",
      "contextWindow": 2000000,
      "maxOutput": 1800000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "x-ai/grok-4.20-multi-agent": {
      "id": "x-ai/grok-4.20-multi-agent",
      "name": "Grok 4.20 Multi-Agent",
      "contextWindow": 2000000,
      "maxOutput": 1800000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "vision",
        "pdf"
      ]
    },
    "x-ai/grok-4.3": {
      "id": "x-ai/grok-4.3",
      "name": "Grok 4.3",
      "contextWindow": 1000000,
      "maxOutput": 900000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "x-ai/grok-4.5": {
      "id": "x-ai/grok-4.5",
      "name": "Grok 4.5",
      "contextWindow": 500000,
      "maxOutput": 450000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "x-ai/grok-4.6": {
      "id": "x-ai/grok-4.6",
      "name": "Grok 4.6",
      "contextWindow": 500000,
      "maxOutput": 450000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "x-ai/grok-4.7": {
      "id": "x-ai/grok-4.7",
      "name": "Grok 4.7",
      "contextWindow": 500000,
      "maxOutput": 450000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "x-ai/grok-build-0.1": {
      "id": "x-ai/grok-build-0.1",
      "name": "Grok Build 0.1",
      "contextWindow": 256000,
      "maxOutput": 230400,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "xiaomi/mimo-v2.5": {
      "id": "xiaomi/mimo-v2.5",
      "name": "MiMo-V2.5",
      "contextWindow": 1050000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "xiaomi/mimo-v2.5-pro": {
      "id": "xiaomi/mimo-v2.5-pro",
      "name": "MiMo-V2.5-Pro",
      "contextWindow": 1050000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "xiaomi/mimo-v2.6-flash": {
      "id": "xiaomi/mimo-v2.6-flash",
      "name": "MiMo-V2.6-Flash",
      "contextWindow": 1050000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "xiaomi/mimo-v2.6-pro": {
      "id": "xiaomi/mimo-v2.6-pro",
      "name": "MiMo-V2.6-Pro",
      "contextWindow": 1050000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
      "id": "xiaomi/mimo-v2.6-pro-ultraspeed",
      "name": "MiMo-V2.6-Pro-UltraSpeed",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video"
      ]
    },
    "z-ai/glm-4.5": {
      "id": "z-ai/glm-4.5",
      "name": "GLM-4.5",
      "contextWindow": 131072,
      "maxOutput": 98304,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-4.5-air": {
      "id": "z-ai/glm-4.5-air",
      "name": "GLM-4.5-Air",
      "contextWindow": 131072,
      "maxOutput": 98304,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-4.5v": {
      "id": "z-ai/glm-4.5v",
      "name": "GLM-4.5V",
      "contextWindow": 65536,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "z-ai/glm-4.6": {
      "id": "z-ai/glm-4.6",
      "name": "GLM-4.6",
      "contextWindow": 204800,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-4.6v": {
      "id": "z-ai/glm-4.6v",
      "name": "GLM-4.6V",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "z-ai/glm-4.7": {
      "id": "z-ai/glm-4.7",
      "name": "GLM-4.7",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-4.7-flash": {
      "id": "z-ai/glm-4.7-flash",
      "name": "GLM-4.7-Flash",
      "contextWindow": 200000,
      "maxOutput": 117964,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5": {
      "id": "z-ai/glm-5",
      "name": "GLM-5",
      "contextWindow": 204800,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5-turbo": {
      "id": "z-ai/glm-5-turbo",
      "name": "GLM-5-Turbo",
      "contextWindow": 202752,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5.1": {
      "id": "z-ai/glm-5.1",
      "name": "GLM-5.1",
      "contextWindow": 204800,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5.2": {
      "id": "z-ai/glm-5.2",
      "name": "GLM-5.2",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5.3": {
      "id": "z-ai/glm-5.3",
      "name": "GLM-5.3",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5.3-flash": {
      "id": "z-ai/glm-5.3-flash",
      "name": "GLM-5.3-Flash",
      "contextWindow": 1048576,
      "maxOutput": 943717,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "z-ai/glm-5.3-flashx": {
      "id": "z-ai/glm-5.3-flashx",
      "name": "GLM 5.3 FlashX",
      "contextWindow": 1048576,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "z-ai/glm-5.3-prime": {
      "id": "z-ai/glm-5.3-prime",
      "name": "GLM 5.3 Prime",
      "contextWindow": 1000000,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "z-ai/glm-5v-turbo": {
      "id": "z-ai/glm-5v-turbo",
      "name": "GLM-5V-Turbo",
      "contextWindow": 202752,
      "maxOutput": 131072,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "~anthropic/claude-fable-latest": {
      "id": "~anthropic/claude-fable-latest",
      "name": "Claude Fable Latest",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~anthropic/claude-haiku-latest": {
      "id": "~anthropic/claude-haiku-latest",
      "name": "Claude Haiku Latest",
      "contextWindow": 200000,
      "maxOutput": 64000,
      "reasoning": {
        "kind": "toggle"
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~anthropic/claude-opus-latest": {
      "id": "~anthropic/claude-opus-latest",
      "name": "Claude Opus Latest",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~anthropic/claude-sonnet-latest": {
      "id": "~anthropic/claude-sonnet-latest",
      "name": "Claude Sonnet Latest",
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~deepseek/deepseek-flash-latest": {
      "id": "~deepseek/deepseek-flash-latest",
      "name": "DeepSeek Flash Latest",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "~deepseek/deepseek-pro-latest": {
      "id": "~deepseek/deepseek-pro-latest",
      "name": "DeepSeek Pro Latest",
      "contextWindow": 1048576,
      "maxOutput": 393216,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "~deepseek/deepseek-v4-flash-latest": {
      "id": "~deepseek/deepseek-v4-flash-latest",
      "name": "DeepSeek V4 Flash Latest",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "~google/gemini-flash-latest": {
      "id": "~google/gemini-flash-latest",
      "name": "Gemini Flash Latest",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "~google/gemini-pro-latest": {
      "id": "~google/gemini-pro-latest",
      "name": "Gemini Pro Latest",
      "contextWindow": 1048576,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "audio",
        "video",
        "pdf"
      ]
    },
    "~moonshotai/kimi-latest": {
      "id": "~moonshotai/kimi-latest",
      "name": "Kimi Latest",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "~openai/gpt-astra-latest": {
      "id": "~openai/gpt-astra-latest",
      "name": "GPT Astra Latest",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~openai/gpt-luna-latest": {
      "id": "~openai/gpt-luna-latest",
      "name": "GPT Luna Latest",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~openai/gpt-mini-latest": {
      "id": "~openai/gpt-mini-latest",
      "name": "GPT Mini Latest",
      "contextWindow": 400000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~openai/gpt-sol-latest": {
      "id": "~openai/gpt-sol-latest",
      "name": "GPT Sol Latest",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~openai/gpt-terra-latest": {
      "id": "~openai/gpt-terra-latest",
      "name": "GPT Terra Latest",
      "contextWindow": 1050000,
      "maxOutput": 128000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~x-ai/grok-latest": {
      "id": "~x-ai/grok-latest",
      "name": "Grok Latest",
      "contextWindow": 500000,
      "maxOutput": 450000,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high",
          "xhigh"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "pdf"
      ]
    },
    "~z-ai/glm-flash-latest": {
      "id": "~z-ai/glm-flash-latest",
      "name": "GLM Flash Latest",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision",
        "video"
      ]
    },
    "~z-ai/glm-latest": {
      "id": "~z-ai/glm-latest",
      "name": "GLM Latest",
      "contextWindow": 1048576,
      "maxOutput": 943718,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    }
  },
  "groq": {
    "allam-2-7b": {
      "id": "allam-2-7b",
      "name": "ALLaM-2-7b",
      "contextWindow": 4096,
      "maxOutput": 4096
    },
    "canopylabs/orpheus-arabic-saudi": {
      "id": "canopylabs/orpheus-arabic-saudi",
      "name": "Canopy Labs Orpheus Arabic Saudi",
      "contextWindow": 4000,
      "maxOutput": 50000
    },
    "canopylabs/orpheus-v1-english": {
      "id": "canopylabs/orpheus-v1-english",
      "name": "Canopy Labs Orpheus V1 English",
      "contextWindow": 4000,
      "maxOutput": 50000
    },
    "groq/compound": {
      "id": "groq/compound",
      "name": "Compound",
      "contextWindow": 131072,
      "maxOutput": 8192
    },
    "groq/compound-mini": {
      "id": "groq/compound-mini",
      "name": "Compound Mini",
      "contextWindow": 131072,
      "maxOutput": 8192
    },
    "llama-3.1-8b-instant": {
      "id": "llama-3.1-8b-instant",
      "name": "Llama 3.1 8B",
      "contextWindow": 131072,
      "maxOutput": 131072,
      "capabilities": [
        "tools"
      ]
    },
    "llama-3.3-70b-versatile": {
      "id": "llama-3.3-70b-versatile",
      "name": "Llama 3.3 70B",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "capabilities": [
        "tools"
      ]
    },
    "meta-llama/llama-prompt-guard-2-22m": {
      "id": "meta-llama/llama-prompt-guard-2-22m",
      "name": "Llama Prompt Guard 2 22M",
      "contextWindow": 512,
      "maxOutput": 512
    },
    "meta-llama/llama-prompt-guard-2-86m": {
      "id": "meta-llama/llama-prompt-guard-2-86m",
      "name": "Prompt Guard 2 86M",
      "contextWindow": 512,
      "maxOutput": 512
    },
    "openai/gpt-oss-120b": {
      "id": "openai/gpt-oss-120b",
      "name": "GPT OSS 120B",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-oss-20b": {
      "id": "openai/gpt-oss-20b",
      "name": "GPT OSS 20B",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "openai/gpt-oss-safeguard-20b": {
      "id": "openai/gpt-oss-safeguard-20b",
      "name": "Safety GPT OSS 20B",
      "contextWindow": 131072,
      "maxOutput": 65536,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3.6-27b": {
      "id": "qwen/qwen3.6-27b",
      "name": "Qwen3.6 27B",
      "contextWindow": 131072,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "default"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "qwen/qwen3.8-27b": {
      "id": "qwen/qwen3.8-27b",
      "name": "Qwen3.8 27B",
      "contextWindow": 131042,
      "maxOutput": 16384,
      "reasoning": {
        "kind": "effort",
        "values": [
          "none",
          "default",
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "whisper-large-v3": {
      "id": "whisper-large-v3",
      "name": "Whisper",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "audio"
      ]
    },
    "whisper-large-v3-turbo": {
      "id": "whisper-large-v3-turbo",
      "name": "Whisper Large V3 Turbo",
      "contextWindow": 0,
      "maxOutput": 0,
      "capabilities": [
        "audio"
      ]
    }
  },
  "deepseek": {
    "deepseek-flash": {
      "id": "deepseek-flash",
      "name": "DeepSeek V4.1 Flash",
      "contextWindow": 1000000,
      "maxOutput": 393216,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "deepseek-v4-flash": {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "contextWindow": 1000000,
      "maxOutput": 393216,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "deepseek-v4-flash-vision-exp": {
      "id": "deepseek-v4-flash-vision-exp",
      "name": "DeepSeek V4 Flash Vision Exp",
      "contextWindow": 1000000,
      "maxOutput": 393216,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools",
        "vision"
      ]
    },
    "deepseek-v4-pro": {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "contextWindow": 1000000,
      "maxOutput": 393216,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "high",
          "max"
        ]
      },
      "capabilities": [
        "tools"
      ]
    }
  },
  "ollama": {},
  "lmstudio": {
    "openai/gpt-oss-20b": {
      "id": "openai/gpt-oss-20b",
      "name": "GPT OSS 20B",
      "contextWindow": 131072,
      "maxOutput": 32768,
      "reasoning": {
        "kind": "effort",
        "values": [
          "low",
          "medium",
          "high"
        ]
      },
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-30b-a3b-2507": {
      "id": "qwen/qwen3-30b-a3b-2507",
      "name": "Qwen3 30B A3B 2507",
      "contextWindow": 262144,
      "maxOutput": 16384,
      "capabilities": [
        "tools"
      ]
    },
    "qwen/qwen3-coder-30b": {
      "id": "qwen/qwen3-coder-30b",
      "name": "Qwen3 Coder 30B",
      "contextWindow": 262144,
      "maxOutput": 65536,
      "capabilities": [
        "tools"
      ]
    }
  }
};
