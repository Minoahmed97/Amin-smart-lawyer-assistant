import { listApprovedProfessionalMemories } from './store.ts';
import { formatApprovedMemoryContext } from './policy.ts';
import type { LearningTaskType } from './types.ts';

/**
 * Retrieves only lawyer-approved global professional memories for a live task.
 * Case-scoped memories are deliberately excluded until the active case reference
 * is explicitly connected to the task workflow.
 *
 * Learning storage is an additive aid: retrieval failure must not disable an
 * otherwise healthy legal AI task.
 */
export async function getApprovedLearningInstruction(
  userId: string,
  taskType: LearningTaskType,
  caseRef?: string | null,
): Promise<string> {
  try {
    const memories = await listApprovedProfessionalMemories(userId, 200, caseRef);
    const context = formatApprovedMemoryContext(memories, {
      caseRef,
      taskType,
      maxCharacters: 9000,
    });
    if (!context) return '';

    return [
      '[مرجع الخبرة المهنية المعتمدة — توجيه مساعد لا يحل محل ملف القضية]',
      'استفد من الخبرات العامة التالية بقدر انطباقها فقط. هي تفضيلات ومنهج عمل للمحامي وليست وقائع أو أدلة أو مصادر قانونية.',
      'لا تطبق قاعدة إذا خالفت وقائع الملف الحالي أو طلب المحامي الصريح أو القانون الواجب التطبيق.',
      'لا تحول قراراً ظرفياً أو خبرة سابقة إلى قاعدة مطلقة، ولا تنقل أسماء أو وقائع أو طلبات من قضية سابقة.',
      'إذا لم تنطبق خبرة على المهمة الحالية فتجاوزها دون الإشارة إليها.',
      context,
      '[/مرجع الخبرة المهنية المعتمدة]',
    ].join('\n');
  } catch {
    // Preserve the existing AI workflow if the optional learning store is unavailable.
    console.warn('[amin-learning] approved memory retrieval skipped; continuing without learning context');
    return '';
  }
}
