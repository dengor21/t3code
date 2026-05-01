import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const project of input.projects) {
    mapping.set(
      derivePhysicalProjectKey(project),
      deriveLogicalProjectKeyFromSettings(project, input.settings),
    );
  }
  return mapping;
}

/*
export function temp(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (EnvironmentId: EnvironmentId) => string | null;
}): SidebarProjectSnapshot[] {
  const groupedMembers = groupProjectsByLogicalKey(input);
  return buildSnapshotsFromGroups({
    ...input,
    groupedMembers,
  });
}
*/

function groupProjectsByLogicalKey(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): Map<string, SidebarProjectGroupMember[]> {
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();

  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);

    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };

    const existing = groupedMembers.get(logicalKey);

    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  return groupedMembers;
}

function chooseRepresentativeProject(input: {
  members: readonly SidebarProjectGroupMember[];
  primaryEnvironmentId: EnvironmentId | null;
}): SidebarProjectGroupMember | null {
  return (
    (input.primaryEnvironmentId
      ? input.members.find((member) => member.environmentId === input.primaryEnvironmentId)
      : null) ??
    input.members[0] ??
    null
  );
}

function deriveEnvironmentPresence(input: {
  members: readonly SidebarProjectGroupMember[];
  primaryEnvrionmentId: EnvironmentId | null;
}): EnvironmentPresence {
  const hasLocal =
    input.primaryEnvrionmentId !== null &&
    input.members.some((member) => member.environmentId === input.primaryEnvrionmentId);

  const hasRemote =
    input.primaryEnvrionmentId !== null
      ? input.members.some((member) => member.environmentId !== input.primaryEnvrionmentId)
      : false;

  return hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only";
}

function collectRemoteEnvironmentLabels(input: {
  members: readonly SidebarProjectGroupMember[];
  primaryEnvironmentId: EnvironmentId | null;
}): string[] {
  return input.members
    .filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    )
    .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
    .filter((label, index, labels) => labels.indexOf(label) == index);
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): SidebarProjectSnapshot[] {
  const groupedMembers = groupProjectsByLogicalKey(input);

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative = chooseRepresentativeProject({
      members,
      primaryEnvironmentId: input.primaryEnvironmentId,
    });

    if (!representative) {
      continue;
    }

    const remoteEnvironmentLabels = collectRemoteEnvironmentLabels({
      members,
      primaryEnvironmentId: input.primaryEnvironmentId,
    });

    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.name,
      groupedProjectCount: members.length,
      environmentPresence: deriveEnvironmentPresence({
        members,
        primaryEnvrionmentId: input.primaryEnvironmentId,
      }),
      memberProjects: members,
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels,
    });
  }

  return result;
}
