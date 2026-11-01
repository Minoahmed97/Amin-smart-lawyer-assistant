/**
 * مصادر البحث القانوني المصري.
 * الروابط لا تعني أن كل وثيقة منشورة بها رسمية أو محدثة؛ يجب فحص أصل الحكم
 * والنص التشريعي وتاريخ السريان قبل الاستشهاد.
 */
export type EgyptianLegalSource = {
  id: string;
  court: string;
  kind: 'تشريعات' | 'نقض' | 'إدارية عليا' | 'دستورية عليا';
  title: string;
  url: string;
  authority: 'رسمي' | 'مستودع غير رسمي';
  verificationNote: string;
};

export const EGYPTIAN_LEGAL_SOURCES: EgyptianLegalSource[] = [
  {
    id: 'legislation',
    court: 'هيئة المطابع الأميرية',
    kind: 'تشريعات',
    title: 'منظومة التشريعات المصرية والجريدة الرسمية والوقائع المصرية',
    url: 'https://www.alamiria.com/Sec/Home',
    authority: 'رسمي',
    verificationNote: 'الأصل في التحقق من نشر القانون أو القرار؛ راجع العدد وتاريخ النشر والتعديلات اللاحقة.',
  },
  {
    id: 'cassation',
    court: 'محكمة النقض',
    kind: 'نقض',
    title: 'المكتب الفني لمحكمة النقض — المنشورات والمبادئ القانونية',
    url: 'https://register.cc.gov.eg/',
    authority: 'رسمي',
    verificationNote: 'تحقق من الحكم أو مجموعة المكتب الفني ورقم الطعن والسنة والدائرة وتاريخ الجلسة.',
  },
  {
    id: 'administrative-supreme',
    court: 'المحكمة الإدارية العليا',
    kind: 'إدارية عليا',
    title: 'مستودع الوثائق — أحكام المحكمة الإدارية العليا',
    url: 'https://www.mksegypt.org/ar/documents',
    authority: 'مستودع غير رسمي',
    verificationNote: 'يستخدم كوسيلة بحث أولية فقط؛ لا تنسب الحكم للمحكمة قبل مطابقة صورته أو مصدره القضائي.',
  },
  {
    id: 'constitutional',
    court: 'المحكمة الدستورية العليا',
    kind: 'دستورية عليا',
    title: 'الموقع الرسمي للمحكمة الدستورية العليا — الأحكام',
    url: 'https://www.sccourt.gov.eg/SCC/',
    authority: 'رسمي',
    verificationNote: 'راجع منطوق الحكم وأسبابه وتاريخ نشره بالجريدة الرسمية وآثاره الزمنية.',
  },
];
