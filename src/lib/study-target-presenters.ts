import type { StudyTarget, StudyTargetEvidence } from "@/lib/study-targets";

export interface StudyAssistantPromptOption {
  label: string;
  prompt: string;
  context?: {
    courseId?: string;
    courseName?: string;
    topicName?: string;
    targetEvidence?: StudyTargetEvidence;
  };
  note?: string;
}

export function summarizeStudyTargetEvidence(evidence: StudyTargetEvidence): string[] {
  const lines: string[] = [];

  if (evidence.weekLabel) {
    lines.push(evidence.weekLabel);
  }

  if (evidence.readings.length > 0) {
    lines.push(evidence.readings.slice(0, 2).join(", "));
  } else if (evidence.materials.length > 0) {
    lines.push(`Imported: ${evidence.materials[0].fileName}`);
  } else if (evidence.candidates.length > 0) {
    lines.push(`Canvas: ${evidence.candidates[0].fileName}`);
  }

  return lines.slice(0, 2);
}

export function getImportableCandidate(evidence: StudyTargetEvidence) {
  const [topCandidate] = evidence.candidates;
  if (!topCandidate || topCandidate.requested) return null;
  return topCandidate;
}

type StudyTargetLike = Pick<StudyTarget, "courseId" | "courseName" | "topicName" | "readings" | "evidence">;

function buildPromptLabel(target: StudyTargetLike): string {
  return `${target.courseName}: ${target.topicName}`;
}

function buildPromptText(target: StudyTargetLike): string {
  if (target.readings.length > 0) {
    return `Help me review ${target.topicName} in ${target.courseName}, especially how it connects to ${target.readings.slice(0, 2).join(" and ")}.`;
  }

  return `Help me review ${target.topicName} in ${target.courseName}. Start with the core idea and what I should understand first.`;
}

export function buildStudyAssistantPromptOptions(
  targets: StudyTargetLike[],
  limit = 6
): StudyAssistantPromptOption[] {
  const seen = new Set<string>();
  const uniqueTargets = targets.filter((target) => {
    const key = `${target.courseId}:${target.topicName.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const firstByCourse = new Map<string, StudyTargetLike>();
  const extras: StudyTargetLike[] = [];
  for (const target of uniqueTargets) {
    if (!firstByCourse.has(target.courseId)) {
      firstByCourse.set(target.courseId, target);
    } else {
      extras.push(target);
    }
  }

  const selected = [...firstByCourse.values(), ...extras].slice(0, limit);

  return selected.map((target) => ({
    label: buildPromptLabel(target),
    prompt: buildPromptText(target),
    context: {
      courseId: target.courseId,
      courseName: target.courseName,
      topicName: target.topicName,
      targetEvidence: target.evidence,
    },
    note: summarizeStudyTargetEvidence(target.evidence)[0],
  }));
}
