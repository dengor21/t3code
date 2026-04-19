/**
 * TextGeneration - Effect service contract for AI-generated Git content.
 *
 * Generates commit messages and pull request titles/bodies from repository
 * context prepared by Git services.
 *
 * @module TextGeneration
 */
import { Context } from "effect";
import type { Effect } from "effect";
import type { ChatAttachment, ModelSelection } from "@t3tools/contracts";

import type { TextGenerationError } from "@t3tools/contracts";

/** Providers that support git text generation (commit messages, PR content, branch names). */
export type TextGenerationProvider = "codex" | "claudeAgent";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface ChangeDocumentationGenerationInput {
  cwd: string;
  projectTitle: string;
  threadTitle: string;
  assistantResponse: string;
  changedFilesSummary: string;
  diffPatch: string;
  hosts: ReadonlyArray<{
    name: string;
    target: string;
    system?: string | undefined;
    type?: string | undefined;
  }>;
  modelSelection: ModelSelection;
}

export interface ChangeDocumentationGenerationResult {
  headline: string;
  summary: string;
  changes: ReadonlyArray<string>;
  hostImpact: string;
}

export interface InitialDocumentationGenerationInput {
  cwd: string;
  projectTitle: string;
  summaryLabel: string;
  currentFilesSummary: string;
  currentStateSnapshot: string;
  hosts: ReadonlyArray<{
    name: string;
    target: string;
    system?: string | undefined;
    type?: string | undefined;
  }>;
  modelSelection: ModelSelection;
}

export interface HostDocumentationGenerationInput {
  cwd: string;
  projectTitle: string;
  host: {
    name: string;
    target: string;
    system?: string | undefined;
    type?: string | undefined;
  };
  contextFiles: ReadonlyArray<{
    path: string;
    contents: string;
  }>;
  modelSelection: ModelSelection;
}

export interface HostDocumentationGenerationResult {
  overview: string;
  rolesAndPurpose: ReadonlyArray<string>;
  appsAndUserEnvironment: ReadonlyArray<string>;
  servicesAndSystemBehavior: ReadonlyArray<string>;
  networkingAndAccess: ReadonlyArray<string>;
  storageAndHardware: ReadonlyArray<string>;
  deploymentAndOperations: ReadonlyArray<string>;
  knownGaps: ReadonlyArray<string>;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateChangeDocumentation(
    input: ChangeDocumentationGenerationInput,
  ): Promise<ChangeDocumentationGenerationResult>;
  generateInitialDocumentation(
    input: InitialDocumentationGenerationInput,
  ): Promise<ChangeDocumentationGenerationResult>;
  generateHostDocumentation(
    input: HostDocumentationGenerationInput,
  ): Promise<HostDocumentationGenerationResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise thread title from a user's first message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Generate a structured documentation entry for a completed turn.
   */
  readonly generateChangeDocumentation: (
    input: ChangeDocumentationGenerationInput,
  ) => Effect.Effect<ChangeDocumentationGenerationResult, TextGenerationError>;

  /**
   * Generate a structured bootstrap documentation entry for the current flake state.
   */
  readonly generateInitialDocumentation: (
    input: InitialDocumentationGenerationInput,
  ) => Effect.Effect<ChangeDocumentationGenerationResult, TextGenerationError>;

  /**
   * Generate a verbose current-state host document from source files.
   */
  readonly generateHostDocumentation: (
    input: HostDocumentationGenerationInput,
  ) => Effect.Effect<HostDocumentationGenerationResult, TextGenerationError>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "t3/git/Services/TextGeneration",
) {}
