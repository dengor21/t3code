import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type NixDesignerScope,
  type ScopedProjectRef,
  type ThreadWorkflow,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { shouldReuseDraftForThreadStart } from "../lib/threadStartDraftReuse";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { deriveLogicalProjectKeyFromSettings, getProjectOrderKey } from "../logicalProject";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveFlakeRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";

function useNewThreadState() {
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        designer?: NixDesignerScope | null;
        scopedHostName?: string | null;
        workflow?: ThreadWorkflow | null;
        interactionMode?: "default" | "plan";
        initialPrompt?: string;
      },
    ): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        getComposerDraft,
        applyStickyState,
        setPrompt,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasDesignerOption = options?.designer !== undefined;
      const hasScopedHostOption = options?.scopedHostName !== undefined;
      const hasWorkflowOption = options?.workflow !== undefined;
      const hasInteractionModeOption = options?.interactionMode !== undefined;
      const normalizedInitialPrompt = options?.initialPrompt?.trim() ?? "";
      const seedDraftPromptIfEmpty = (draftId: DraftId) => {
        if (normalizedInitialPrompt.length === 0) {
          return;
        }
        const existingPrompt = getComposerDraft(draftId)?.prompt ?? "";
        if (existingPrompt.trim().length > 0) {
          return;
        }
        setPrompt(draftId, normalizedInitialPrompt);
      };
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      const shouldReuseStoredDraft =
        storedDraftThread !== null &&
        shouldReuseDraftForThreadStart({
          requestedDesigner: options?.designer ?? null,
          requestedScopedHostName: options?.scopedHostName ?? null,
          requestedWorkflow: options?.workflow ?? null,
          existingDesigner: storedDraftThread.designer ?? null,
          existingScopedHostName: storedDraftThread.scopedHostName ?? null,
          existingWorkflow: storedDraftThread.workflow ?? null,
          existingPrompt: getComposerDraft(storedDraftThread.draftId)?.prompt ?? "",
        });
      if (storedDraftThread && shouldReuseStoredDraft) {
        return (async () => {
          if (
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasDesignerOption ||
            hasScopedHostOption ||
            hasWorkflowOption ||
            hasInteractionModeOption
          ) {
            setDraftThreadContext(storedDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
              ...(hasDesignerOption ? { designer: options?.designer ?? null } : {}),
              ...(hasScopedHostOption ? { scopedHostName: options?.scopedHostName ?? null } : {}),
              ...(hasWorkflowOption ? { workflow: options?.workflow ?? null } : {}),
              ...(hasInteractionModeOption ? { interactionMode: options?.interactionMode } : {}),
            });
          }
          seedDraftPromptIfEmpty(storedDraftThread.draftId);
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, storedDraftThread.draftId, {
            threadId: storedDraftThread.threadId,
          });
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === storedDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: storedDraftThread.draftId },
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        shouldReuseDraftForThreadStart({
          requestedDesigner: options?.designer ?? null,
          requestedScopedHostName: options?.scopedHostName ?? null,
          requestedWorkflow: options?.workflow ?? null,
          existingDesigner: latestActiveDraftThread.designer ?? null,
          existingScopedHostName: latestActiveDraftThread.scopedHostName ?? null,
          existingWorkflow: latestActiveDraftThread.workflow ?? null,
          existingPrompt: getComposerDraft(currentRouteTarget.draftId)?.prompt ?? "",
        })
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasDesignerOption ||
          hasScopedHostOption ||
          hasWorkflowOption ||
          hasInteractionModeOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            ...(hasDesignerOption ? { designer: options?.designer ?? null } : {}),
            ...(hasScopedHostOption ? { scopedHostName: options?.scopedHostName ?? null } : {}),
            ...(hasWorkflowOption ? { workflow: options?.workflow ?? null } : {}),
            ...(hasInteractionModeOption ? { interactionMode: options?.interactionMode } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          ...(hasDesignerOption ? { designer: options?.designer ?? null } : {}),
          ...(hasScopedHostOption ? { scopedHostName: options?.scopedHostName ?? null } : {}),
          ...(hasWorkflowOption ? { workflow: options?.workflow ?? null } : {}),
          ...(hasInteractionModeOption ? { interactionMode: options?.interactionMode } : {}),
        });
        seedDraftPromptIfEmpty(currentRouteTarget.draftId);
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          designer: options?.designer ?? null,
          scopedHostName: options?.scopedHostName ?? null,
          workflow: options?.workflow ?? null,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: options?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        });
        applyStickyState(draftId);
        seedDraftPromptIfEmpty(draftId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
      })();
    },
    [getCurrentRouteTarget, projectGroupingSettings, router, projects],
  );
}

export function useNewThreadHandler() {
  const handleNewThread = useNewThreadState();

  return {
    handleNewThread,
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeProjectRef = useParams({
    strict: false,
    select: (params) => resolveFlakeRouteRef(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadState();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef:
      routeProjectRef ??
      (orderedProjects[0]
        ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
        : null),
    handleNewThread,
    routeThreadRef,
  };
}
