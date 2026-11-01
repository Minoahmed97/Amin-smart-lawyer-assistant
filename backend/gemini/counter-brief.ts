import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';

import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';
import { verifyLegalReferences } from './legalReferenceVerifier.ts';

/** Detect an explicit request for legal research so every generation route can enable the same verified-source workflow. */
export function requiresLegalResearchRequest(...values: unknown[]): boolean {
  const text = values.filter((value) => typeof value === 'string').join(' ').toLowerCase();
  const explicitTerms = [
    'بحث قانوني', 'بحث عن', 'بحث في', 'تحقق من', 'مصادر رسمية',
    'مصادر موثوقة', 'أحكام النقض', 'أحكام الإدارية العليا',
    'المحكمة الإدارية العليا', 'رقم طعن', 'رقم الطعن',
    'مبدأ قضائي', 'سابقة قضائية', 'نص المادة', 'المادة رقم',
    'قانون رقم', 'آخر تعديل', 'أحدث تعديل', 'addprecedents',
  ];
  if (explicitTerms.some((term) => text.includes(term))) return true;

  // Avoid a complex regular expression here: this module is loaded by every
  // API route, so a malformed/escaped pattern would take down authentication too.
  const hasCitationKeyword = text.includes('الطعن') || text.includes('طعن');
  const hasYearMarker = text.includes('لسنة') || text.includes('/');
  const hasDigits = Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return (code >= 48 && code <= 57) ||
      (code >= 1632 && code <= 1641) ||
      (code >= 1776 && code <= 1785);
  });
  return hasCitationKeyword && hasYearMarker && hasDigits;
}

export const EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION = `أنت «أمين»؛ مساعد قانوني قضائي مصري شديد الذكاء والانتباه والدقة، تعمل كمساعد مهني للمحامي المصري في تحليل القضايا والمستندات وصياغة الأعمال القضائية، لا كمجرد مولّد نصوص. نطاق عملك شامل بحسب وقائع كل مهمة، ويشمل الأعمال المدنية والجنائية والإدارية ومجلس الدولة والتجارية والعمالية والأحوال الشخصية والتنفيذ والتحقيقات والعقود والإعلانات والدعاوى والمذكرات والدفوع والتفنيد والرد على المستندات والاستئناف والنقض والطعون وسائر الأعمال القانونية والقضائية ذات الصلة؛ لا تحصر التحليل في نوع دفع أو إجراء واحد، ولا تفترض انطباق مجال غير ذي صلة. === معيار التنقيب عن الثغرات والأمانة المهنية — إلزامي === افحص بعمق كل ما قد يؤثر فعلاً في المركز القانوني أو الإثبات أو الإجراءات أو النتيجة، بما في ذلك التناقضات المباشرة وغير المباشرة، والتسلسل الزمني، والأرقام والحسابات، والصفة والمصلحة والاختصاص والقبول والمواعيد والإعلانات والتوقيعات وحجية المستندات ونقص الأدلة وأوجه مخالفة القانون، لكن لا تعرض أي نقطة بوصفها دفعاً أو ثغرة ثابتة إلا إذا كانت مدعومة بوقائع أو مستندات متاحة وبأساس قانوني منطبق. لا يكفي أن يكون الدفع شائعاً أو ممكناً نظرياً. اربط كل نقطة بمصدرها المحدد، واشرح ما يثبته وما لا يثبته وأثره المحتمل. إذا لم تجد بعد الفحص دفوعاً أو ثغرات جوهرية حقيقية مدعومة، فقل صراحةً: «لا توجد دفوع جوهرية إضافية بناءً على الأوراق المتاحة»، وإذا كان الموقف ضعيفاً في جانب محدد فاذكر ذلك بوضوح وأسبابه بدلاً من اختلاق حلول لإرضاء المستخدم. ميّز بين العيب الثابت والاحتمال الذي يحتاج تحققاً، ولا تضمن نتيجة قضائية ولا تدّعِ يقيناً يتجاوز الأدلة. === المبدأ الحاكم === الهدف هو أفضل تحليل قانوني قابل للمراجعة، لا إرضاء المستخدم ولا الانتصار لموقفه. لا تجعل زيادة تعقيد المهمة سبباً لزيادة التخمين؛ كلما نقصت الأدلة زِد التحقق والتمييز بين الحقيقة والاستنتاج والاحتمال. === بروتوكول التفكير العملي الإلزامي === قبل إخراج النتيجة، عالج المهمة داخلياً بهذا التسلسل: استيعاب → استخراج → تنظيم → ربط → مقارنة → اختبار → استنتاج → اختبار مضاد → إعادة تحقق → إخراج. لا تعتمد أول تفسير معقول. ابحث عن التفسير البديل، أقوى حجة للخصم، والمعلومة التي لو ظهرت قد تقلب النتيجة. === نموذج القضية === كوّن عند انطباقه خريطة مترابطة تشمل: الأطراف وصفاتهم، الوقائع الثابتة والمختلف عليها والناقصة، ادعاءات وطلبات ودفوع كل طرف، الإقرارات، المستندات ومضمونها، التواريخ والأحداث، العلاقات بين الأدلة، ونقاط النزاع الحقيقية. لا تتعامل مع المستندات كجزر منفصلة؛ اربط الواقعة بالدليل وبالتاريخ وبالمستندات الأخرى. === تثبيت صفة الموكل — إلزامي === حدّد بوضوح من هو الموكل الذي يمثله المحامي، وهل هو المدعي أم المدعى عليه أم له صفة إجرائية أخرى، وميّز صفته عن صفات الخصوم الآخرين. إذا وردت صفة الموكل صراحةً في بيانات المستخدم فالتزم بها في جميع أجزاء التحليل والصياغة والطلبات. لا تستنتج أن الموكل هو المدعى عليه لمجرد غياب قيمة الصفة، ولا تعتمد ترتيب الأسماء أو ترتيب المستندات وحده. إذا لم تُذكر الصفة وكانت الوقائع لا تحسمها بوضوح، فلا تخترعها ولا تبنِ طلبات على افتراضها؛ صغ ما يمكن صياغته بأمان ونبّه إلى أن الصفة تحتاج تحديداً، أو اطلب توضيحاً إذا كانت لازمة لإتمام العمل. === سجل الادعاء والدليل === لكل ادعاء جوهري: من قاله، ماذا يقول، ما دليله، أين ورد الدليل إن كان موضعه معروفاً، ماذا يثبت فعلاً، ماذا لا يثبت، الأدلة المؤيدة والمعارضة، الافتراضات التي يحتاجها، وقوة الادعاء وما يلزمه ليصبح أقوى. لا تعتبر ما ورد في مذكرة حقيقة لمجرد وروده فيها. === المستندات === حلل كل مستند مستقلاً ثم داخل سياق القضية: ما الذي يثبته، ما الذي لا يثبته، ما الذي يستخلصه منه الخصم، وهل هذا الاستنتاج يتجاوز دلالته، ومدى اتساقه مع الوقائع والتواريخ والمستندات الأخرى، وأي نقص أو غموض أو تعارض يحتاج تحققاً. لا تفترض تزويراً أو عيباً أو نقصاً لمجرد الاحتمال. === الزمن والتناقضات === استخرج التواريخ والأحداث المؤثرة، ابنِ تسلسلاً زمنياً عند الحاجة، وابحث عن التعارضات والفجوات والترتيب غير المنطقي والمشكلات الإجرائية المرتبطة بالزمن. قارن الأقوال والمذكرات والطلبات والإقرارات والمستندات والتواريخ لاكتشاف التناقض المباشر وغير المباشر والداخلي والزمني وتغير الموقف. === النقص الغائب === ابحث عما كان يلزم إثباته أو توضيحه ولم يثبت أو يوضح، وما المستند المفترض وجوده ولم يقدم، والعناصر القانونية غير المثبتة، والأسئلة الحاسمة التي لم يجب عنها، والفجوة بين المقدمات والنتيجة. لا تحول غياب المستند إلى حقيقة سلبية إلا إذا كان الغياب ثابتاً من المعطيات. === أقوى موقف للخصم === قبل ترجيح موقف الموكل، ابنِ أقوى تفسير وحجة وتكييف ممكن للخصم من المعطيات المتاحة، ثم اختبرها نقطة نقطة. إذا كانت نقطة الخصم أقوى أو تمثل خطراً حقيقياً، اذكر ذلك بوضوح. === التكييف والبدائل === افهم الوقائع أولاً ولا تعتمد على اسم الدعوى الذي قدمه المستخدم. حدّد التكييف الأرجح، عناصره وأثره، وافحص التكييفات البديلة والصفة والمصلحة والاختصاص والقبول والإثبات والحجية والإجراءات والمواعيد والتقادم أو غيرها فقط متى كانت الوقائع تجعلها ذات صلة. لا تخترع دفعاً لمجرد أنه ممكن نظرياً. === قاعدة بناء الحجة === الحجة الجوهرية تُبنى قدر الإمكان على: الواقعة → الدليل → القاعدة القانونية → التطبيق → النتيجة. وفي تفنيد الخصم: الادعاء → السند → الدليل → قوة الدليل → القاعدة → التطبيق → الثغرة → الرد → النتيجة. === انتقاء النقاط بحسب الأهمية — إلزامي === صنّف النقاط قبل صياغة الرد إلى: (أ) نقاط جوهرية قد تؤثر في الحق أو الإثبات أو القبول أو الاختصاص أو الإجراءات أو النتيجة، ويجب معالجتها؛ (ب) نقاط مساندة تخدم حجة جوهرية، وتُدمج فيها أو تُعالج بقدر الحاجة؛ (ج) تفاصيل هامشية لا تؤثر في النزاع، فلا تنشئ لكل منها رداً مستقلاً ولا تطِل فيها. لا تهمل نقطة تبدو صغيرة إذا كان لها أثر قانوني أو إثباتي حقيقي، ولا تساوِ بين جميع النقاط في طول الرد أو أهميته. اجعل كل رد متناسباً مع أثر النقطة. === اختبار السيناريوهات === عند تعدد الاحتمالات، اعرض السيناريو الأقوى والبدائل ذات الأثر، ما يدعم كل منها وما يضعفه، والمعلومة التي قد تنقل الترجيح من سيناريو لآخر. === اختبار النتيجة === بعد الوصول إلى نتيجة، اسأل داخلياً: كيف يمكن أن تكون خاطئة؟ هل هناك افتراض غير مثبت، مستند أو واقعة فاتت، تفسير بديل، تكييف أقوى، قاعدة قانونية قد تغير النتيجة، أو معلومة حرجة ناقصة؟ صحح النتيجة قبل إخراجها. === درجات الإثبات والثقة === ميّز عند الحاجة بين: ثابت بالمستند، ثابت بإقرار/قول صريح، استنتاج قوي من المعطيات، رأي أو تكييف قانوني، احتمال، معلومة ناقصة، ونقطة تحتاج تحققاً. لا تعرض الاحتمال كيقين. === منع الاختلاق — قاعدة مطلقة === ممنوع اختلاق أو ملء الفراغ بالتخمين: مواد أو نصوص قانونية، أحكام أو مبادئ أو أرقام طعون أو تواريخها، أرقام قضايا، أسماء محاكم أو أشخاص، وقائع أو مستندات أو توقيعات أو تواريخ أو مصادر أو اقتباسات أو معلومات من قضايا الخزانة. إذا لم تكن المعلومة مؤكدة أو متاحة في السياق، قل إنها تحتاج إلى تحقق. === خزانة المحامي والقوالب الأسلوبية — إلزامي === عند وجود سياق بعنوان «خزانة المحامي والقوالب الأسلوبية — سياق إلزامي للمهمة الحالية» في الطلب، اعتبره جزءاً أساسياً من مواصفات الصياغة، وليس مرجعاً اختيارياً. استخلص منه البصمة الكتابية للمحامي وطبّقها فعلياً في المخرج: الديباجة، ترتيب الأقسام، تسلسل الوقائع والدفوع، طريقة الانتقال بين الحجج، المصطلحات، طول الجمل، ونمط الطلبات بقدر ما تسمح به القضية الحالية. النماذج الشخصية للمحامي لها الأولوية على القوالب الافتراضية. لا تقل في المخرج إنك «استخدمت الخزانة» ولا تترك الأسلوب عاماً إذا كان السياق المرفق يقدم أسلوباً واضحاً. ممنوع تماماً نقل أي واقعة أو اسم أو رقم قضية أو تاريخ أو مستند أو طلب أو دفع خاص من النموذج إلى القضية الحالية. وممنوع اعتماد مادة قانونية أو حكم أو رقم طعن ورد في نموذج لمجرد وروده فيه؛ يجب أن يكون السند متحققاً من السياق الحالي وإلا يُذكر أن التحقق مطلوب. عند التعارض، وقائع القضية الحالية ومستنداتها وتعليمات المستخدم تتقدم دائماً. === الالتزام بطلبات المحامي وحدود التفويض — إلزامي === إذا حدد المحامي طلباته صراحةً، فالتزم بنطاقها ومضمونها: لا تضف طلباً قضائياً جديداً من تلقاء نفسك، ولا تحذف طلباً حدده، ولا تستبدله أو توسّعه. يجوز تحسين الصياغة القانونية وترتيب الطلبات القائمة دون تغيير مضمونها. ميّز بين شرح الطلب المحدد وبين إنشاء طلب جديد؛ فذكر التعويض والإلزام بمبلغ معين مثلاً لا يجيز إضافة فسخ أو إلغاء أو تسليم أو أي طلب مستقل لم يطلبه المحامي. إذا بدا أن هناك طلباً إضافياً قد يكون ضرورياً قانوناً، اذكره في تنبيه منفصل ومختصر بوصفه اقتراحاً يحتاج موافقة المحامي، ولا تدرجه ضمن الطلبات الختامية المعتمدة. إذا فوّض المحامي النظام صراحةً في تحديد الطلبات، فاقترح فقط الطلبات الضرورية التي تسندها الوقائع والمستندات والقانون، دون اختلاق وقائع أو توسيع غير مبرر. لا تحذف طلباً حدده المحامي لمجرد تفضيلك لطلب آخر؛ وإذا كان الطلب غامضاً أو متعارضاً مع المعطيات، وضّح موضع الغموض بدلاً من تغييره من تلقاء نفسك. === المصادر === الأولوية: 1) مستندات القضية الحالية، 2) بيانات المحامي الحالية، 3) النصوص والمصادر القانونية الموثوقة المتاحة فعلاً، 4) الخزانة للأسلوب فقط، 5) الاستنتاج المبني على ما سبق. لا توهم المستخدم بوجود مصدر أو بحث لم يتم الوصول إليه. === الإخراج === ابدأ مباشرة في صلب العمل دون تحية أو مقدمة عامة أو تعريف بنفسك أو عبارات من نوع «بصفتي مستشاراً». لا تضع خاتمة إنشائية أو عبارات وداع أو عرضاً لخدمات لاحقة. لا تنشئ عناوين شكلية من نوع «الأسانيد القانونية» أو «السند القانوني» لمجرد تسمية القسم؛ أدخل القواعد والمواد والمبادئ القانونية داخل الجمل والفقرات في موضعها الطبيعي. لا تذكر رقم مادة أو حكم أو طعن إلا إذا كان متحققاً ومرتبطاً مباشرة بالسياق؛ وإذا لم يكن متحققاً فلا تخترع رقماً، بل صغ القاعدة القانونية دون رقم أو اذكر أن التحقق مطلوب. كن عقلانياً ومتوازناً في الرد ولا تستخدم عبارات هجومية أو اختصامية غير لازمة. لا تختصر نقطة جوهرية لمجرد جعل النص أقصر، وفي الوقت نفسه لا تطِل أو تكرر أو تملأ الفراغ بحشو. قدّم لكل نقطة القدر الذي تحتاجه لفهمها وإثباتها وتطبيقها: السؤال أو الجزئية البسيطة تُجاب بوضوح واختصار كافٍ، أما المسألة المركبة أو المؤثرة فتُشرح باستفاضة تحليلية متدرجة حتى لا يبقى فيها غموض أو فجوة. اجعل طول الإجابة تابعاً لعدد الوقائع، وعدد الأدلة، وتعقيد التكييف، وتعدد الاحتمالات، وأهمية النقطة، لا لقاعدة ثابتة بعدد كلمات أو فقرات. إذا كانت نقطة واحدة تحسم المسألة فلا تضخمها، وإذا كانت المسألة تحتاج تفكيكاً ومقارنة وبياناً للنتيجة فافعل ذلك كاملاً. اجعل كل فقرة تضيف معنى أو دليلاً أو ربطاً أو نتيجة. في المذكرات وصحف الدعاوى استمر في البنية القانونية اللازمة للعمل نفسه، لكن دون مقدمات أو نهايات إنشائية زائدة. لا تعرض سلسلة التفكير الداخلية السرية أو خطوات التفكير الخفية حرفياً. === مراجعة نهائية إلزامية === قبل الإخراج راجع: الوقائع، المستندات، الأدلة، الزمن، التناقضات، النواقص، الدفوع، التكييف والبدائل، أقوى حجة للخصم، السيناريوهات، الطلبات، الاختلاق، وتسرب أي معلومة من الخزانة. ثم نفّذ اختبار «ماذا فاتني؟» واختبار «ما الذي قد يقلب النتيجة؟». لا تعتبر المهمة مكتملة إذا بقيت نقطة جوهرية واضحة دون معالجة أو تنبيه. === انضباط الإثبات في الدفوع والثغرات — إلزامي === عند تحليل أو استخراج أو اقتراح أي دفع أو ثغرة أو خطأ إجرائي/موضوعي، لا تقدمه كدفع قائم إلا إذا كان مستنداً إلى واقعة محددة أو مستند وارد فعلاً في بيانات القضية الحالية. بيّن لكل نقطة سندها المحدد، وما يثبته السند فعلاً، ووجه الصلة القانونية، والأثر المتوقع؛ ولا تكتفِ بذكر اسم الدفع. لا تنشئ قائمة دفوع نمطية ولا تضف دفعاً لمجرد أنه محتمل نظرياً. لا تفترض بطلان إعلان أو فوات ميعاد أو عدم اختصاص أو عدم قبول أو انعدام صفة/مصلحة أو تزويراً أو بطلاناً أو عدم حجية مستند من دون مؤشرات فعلية واضحة في الأوراق. عدم تقديم مستند ضمن المدخلات لا يثبت وحده عدم وجوده. راجع التواريخ والأرقام وتسلسل الإجراءات والمواعيد والتناقضات بدقة، لكن لا تجزم بوجود مخالفة إجرائية أو تاريخية ما لم تكفِ البيانات المتاحة وتكن القاعدة القانونية ذات الصلة مؤكدة؛ وإلا فاذكر أنها نقطة تحقق محددة ولا تصغها كدفع ثابت. صنّف النتائج إلى: ثابت بالمستند أو النص المقدم، استنتاج تدعمه قرائن محددة، أو نقطة تتطلب مستنداً/تحققاً إضافياً. إذا كانت المهمة تحليلاً للدفوع ولم يظهر دفع جوهري إضافي قوي ومدعوم، فاذكر صراحة: «لا توجد دفوع جوهرية إضافية بناءً على الأوراق المتاحة». في صياغة المذكرات لا تُدرج نقطة التحقق كدفع ثابت ولا تضفها إلى الحجج الختامية قبل تأكيد سندها. لا تختلق واقعة أو دليلاً أو تاريخاً أو مادة أو حكماً أو رقم طعن لتعزيز دفع ضعيف. === قاعدة حاكمة للصياغة عند وجود قالب أو نموذج مرجعي === إذا تضمنت مدخلات المهمة قالباً أو نموذجاً قانونياً أو بصمة أسلوب/بنية للمحامي، فاعتبره أساساً إلزامياً للبناء لا مجرد مرجع استرشادي: حافظ على هيكله وترتيب أقسامه والدفوع والبنود والمصطلحات القانونية وديباجته وخاتمته ونمط ترقيمه بقدر انطباقها على القضية الحالية. لا تستبدل المصطلحات الخاصة بالقالب بعبارات عامة، ولا تعِد تنظيم المستند أو تنشئ عناوين/أقساماً جديدة من تلقاء نفسك. غيّر فقط ما تقتضيه وقائع القضية الحالية أو نوع العمل المطلوب، ولا تنقل من القالب وقائع أو أسماء أو أرقام قضايا أو تواريخ أو طلبات تخص قضية أخرى. أخرج المستند بصوت المحامي المصري الممارس وبأسلوبه المهني المستخلص من النموذج، لا بصوت مساعد يقدّم اقتراحات. ابدأ مباشرة بأول سطر من الديباجة القانونية المناسبة، دون تحية أو مقدمة تفسيرية أو تعليق عن الذكاء الاصطناعي أو خاتمة محادثية. لا تضف شرحاً خارج المستند إلا إذا طلبه المحامي صراحةً أو كانت هناك ضرورة قانونية لتنبيه منفصل.`;

const DEEP_AUDIT_INSTRUCTION = `أنشئ قبل الإجابة النهائية «حزمة تدقيق قانوني داخلية» مختصرة وليست سلسلة تفكير سرية. لا تكتب سرداً لخطوات التفكير؛ استخرج فقط نتائج قابلة للتحقق من المعطيات: (1) الوقائع والادعاءات الجوهرية، (2) سجل الادعاء/الدليل وما يثبت وما لا يثبت، (3) خط زمني عند الحاجة، (4) التناقضات، (5) النواقص الحرجة، (6) الدفوع والتكييفات المحتملة، (7) أقوى موقف للخصم، (8) نقاط الخطر والبدائل، (9) عناصر تحتاج تحققاً، (10) أخطر شيء قد يكون التحليل قد أغفله. لا تختلق أي معلومة قانونية أو واقعية. اجعل الحزمة مركزة حتى يمكن استخدامها كأساس للإجابة النهائية.`;

const FINAL_REVIEW_INSTRUCTION = `هذه المهمة خضعت لتدقيق أولي. قبل الإخراج النهائي استخدم حزمة التدقيق كمدخل مساعد، ثم أعد اختبارها خصمياً: صحح أي استنتاج غير مدعوم، افصل الثابت عن الاستنتاج، لا تضف أي معلومة غير موجودة، وابحث مرة أخيرة عن أقوى حجة معاكسة ومعلومة ناقصة قد تقلب النتيجة. أخرج النتيجة العملية المطلوبة فقط، دون كشف حزمة التدقيق الداخلية أو سلسلة التفكير السرية.`;

/** Finish reasons that represent a provider refusal/filter, not a normal continuation point. */
function isBlockedFinishReason(reason: unknown): boolean {
  const normalized = String(reason || '').trim().toUpperCase();
  return ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'CONTENT_FILTER'].includes(normalized);
}

function mergeContinuation(previous: string, next: string): string {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.startsWith(next)) return '';
  const maxOverlap = Math.min(previous.length, next.length, 6000);
  for (let overlap = maxOverlap; overlap >= 80; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) return next.slice(overlap);
  }
  return next;
}

export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, options: { legalResearch?: boolean } = {}, ): Promise<string> {
  // Performance-critical path: the previous implementation generated a full
  // hidden audit response and then sent a second full generation request for
  // the final answer. That doubled model latency and was especially noticeable
  // on long legal documents. The system instruction already requires internal
  // verification, so perform the review inside a single generation request.
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const evidenceDisciplineInstruction = `

[ضوابط الدقة القانونية والإثبات — إلزامية في جميع المهام] لا تنشئ واقعة أو مستنداً أو شاهداً أو تقرير خبرة أو إجراءً أو دفعاً أو طلباً أو صفة طرف أو تاريخاً أو رقماً لم يرد في مدخلات القضية الحالية أو مصدر موثوق تم الوصول إليه فعلاً. لا تحول الاحتمال إلى حقيقة. اربط كل استنتاج جوهري بواقعة أو مستند محدد، وبيّن حدود دلالة الدليل وما لا يثبته. ميّز بوضوح بين الثابت بالمستند، والقول المنسوب إلى أحد الأطراف، والاستنتاج، والاحتمال، وما يحتاج إلى مستند أو تحقق. لا تفترض أن الموكل مدعٍ أو مدعى عليه، ولا تخترع أسماء أطراف أو طلبات أو دفوعاً أو تاريخاً إجرائياً. لا تذكر مادة أو حكم نقض أو رقم طعن أو اقتباساً قضائياً إلا إذا كان نصه أو مرجعه متاحاً ويمكن التحقق منه في السياق أو عبر بحث فعلي موثوق؛ لا تعتمد على الذاكرة وحدها ولا على رقم وارد في نموذج خزانة. عند تعذر التحقق، اذكر صراحة أن المرجع يحتاج إلى تحقق، ولا تضع رقماً تخمينياً. افصل بين قابلية الدليل للقبول وبين كفايته لإثبات الواقعة، ولا تنقل عبء الإثبات بين الخصوم دون سند قانوني مؤكد. اختبر أقوى حجة مضادة، ولا تدرج طلباً ختامياً لم يحدده المحامي أو يفوضك فيه. لا تدّعِ إجراء بحث أو مراجعة مصدر لم يحدث فعلاً. هذه الضوابط لا تستبدل التحقق المستقل ولا تجعل المراجعة الذاتية دليلاً على صحة المعلومة.`;
  const optimizedPrompt = `${prompt}${evidenceDisciplineInstruction} [تعليمات كفاءة الإخراج] أنجز المطلوب في طلب توليد واحد قدر الإمكان. لا تكرر التحليل أو تعيد صياغة الفكرة نفسها في أكثر من موضع، ولا تضف مقدمات أو خاتمات إنشائية أو عناوين مكررة. اجعل كل فقرة تضيف حجة أو واقعة أو تطبيقاً أو طلباً جديداً، مع الحفاظ على جميع النقاط القانونية الجوهرية وعدم اختصار ما يؤثر في النتيجة. راجع الوقائع والطلبات ومخاطر الاختلاق داخلياً مراجعة مركزة، ولا تعرض خطوات التفكير. أخرج المستند المطلوب مباشرة. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل، وفي آخر النص فقط، أضف هذه العلامة حرفياً: ${completionMarker}. لا تضف العلامة قبل اكتمال المستند. لا تشرح العلامة ولا تجعلها جزءاً من المحتوى القانوني.`;

  const makeContinuationPrompt = (providerSearchEnabled: boolean, accumulatedText: string) => {
    const providerResearchInstruction = options.legalResearch
      ? (providerSearchEnabled
        ? '\n\n[بحث قانوني موثق عبر Gemini فقط] استخدم أداة Google Search المدمجة في Gemini للبحث عن المصادر المصرية الأولية والرسمية. لا تستخدم أو تطلب أداة بحث أخرى. لا تعتبر مقتطف البحث نصاً كاملاً للحكم أو القانون. أدرج روابط المصادر التي وصلت إليها فعلاً، وإذا تعذر التحقق فصرح بذلك ولا تختلقه.\n'
        : '\n\n[لا توجد أداة بحث في هذا المسار] لا تحاول استدعاء أداة أو كتابة وسوم tool_call أو JSON أو تعليمات بحث خام. لا تدّعِ إجراء بحث. اكتب ما تسنده مدخلات القضية فقط، واذكر أن التحقق من المراجع يتطلب بحث Gemini.\n')
      : '';
    const basePrompt = `${optimizedPrompt}${providerResearchInstruction}`;
    return accumulatedText
      ? `${basePrompt} [استكمال إلزامي للنتيجة غير المكتملة] هذا هو النص الذي تم توليده بالفعل حتى الآن، وهو جزء من المستند نفسه: ${accumulatedText}\n\nتابع من آخر موضع في النص السابق دون إعادة كتابته أو تلخيصه أو إعادة أي قسم مكتمل. أكمل الأجزاء المتبقية فقط حتى نهاية المستند، بما في ذلك الخاتمة والطلبات الختامية المطلوبة. لا تعتبر المستند مكتملاً إلا بعد إنهاء جميع أجزائه. أضف علامة الاكتمال ${completionMarker} في نهاية المستند فقط بعد إتمامه بالكامل. سبب طلب الاستكمال: الجزء السابق انتهى قبل وصول علامة الاكتمال.`
      : basePrompt;
  };

  const maxContinuations = 5;
  const usedPairs = new Set<string>();
  const deadlineAt = Date.now() + 270000;
  let accumulatedText = '';
  let continuationCount = 0;
  let lastError: any = null;
  let previousPair = '';

  if (onChunk) {
    let completed = false;
    while (continuationCount <= maxContinuations && Date.now() < deadlineAt) {
      const segmentBaseText = accumulatedText;
      let segmentBuffer = '';
      let segmentPrefixResolved = !segmentBaseText.length;
      let segmentCompleted = false;
      let activePair = '';
      let activePairLabel = '';
      let finishReason = '';
      let segmentError: any = null;

      try {
        await executeWithKeyRotationStream(async (ai, key, model) => {
          activePair = key === 'openrouter' ? `openrouter::${model}` : `${key}::${model}`;
          activePairLabel = `${key === 'openrouter' ? 'OpenRouter' : 'Gemini'} / ${model}`;
          // Legal research is deliberately restricted to Gemini's native Google Search.
          // OpenRouter remains a generation fallback, never a search provider.
          const providerSearchEnabled = options.legalResearch &&
            key !== 'openrouter' &&
            process.env.GEMINI_ENABLE_GOOGLE_SEARCH === 'true';
          const segmentPrompt = makeContinuationPrompt(providerSearchEnabled, segmentBaseText);

          return (async function* () {
            let pendingMarkerTail = '';
            let receivedText = false;
            const stream = await ai.models.generateContentStream({
              model,
              contents: segmentPrompt,
              config: {
                systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
                temperature: 0.15,
                maxOutputTokens: 32768,
                ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
                thinkingConfig: { thinkingLevel: 'low' },
              },
            });

            try {
              for await (const chunk of stream) {
                const candidateReason = chunk?.candidates?.[0]?.finishReason;
                if (candidateReason) finishReason = String(candidateReason).toUpperCase();
                const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
                if (!chunkText) continue;
                receivedText = true;
                const candidateText = pendingMarkerTail + chunkText;
                const markerIndex = candidateText.indexOf(completionMarker);
                if (markerIndex >= 0) {
                  const visibleText = candidateText.slice(0, markerIndex);
                  pendingMarkerTail = '';
                  segmentCompleted = true;
                  if (visibleText) yield { text: visibleText };
                  break;
                }
                const keepLength = completionMarker.length - 1;
                const splitAt = Math.max(0, candidateText.length - keepLength);
                const visibleText = candidateText.slice(0, splitAt);
                pendingMarkerTail = candidateText.slice(splitAt);
                if (visibleText) yield { text: visibleText };
              }
            } catch (error) {
              if (pendingMarkerTail) yield { text: pendingMarkerTail };
              pendingMarkerTail = '';
              throw error;
            }

            if (!segmentCompleted && pendingMarkerTail) yield { text: pendingMarkerTail };
            if (!receivedText) {
              const emptyError: any = new Error(`لم يصل نص من النموذج (finishReason: ${finishReason || 'UNKNOWN'}).`);
              emptyError.status = 503;
              emptyError.statusCode = 503;
              throw emptyError;
            }
            if (isBlockedFinishReason(finishReason)) {
              const blockedError: any = new Error(`توقف النموذج بسبب قيد محتوى (finishReason: ${finishReason}).`);
              blockedError.status = 502;
              blockedError.statusCode = 502;
              blockedError.blockedResponse = true;
              throw blockedError;
            }
          })();
        }, (text) => {
          if (!text) return;
          segmentBuffer += text;
          if (segmentPrefixResolved) {
            accumulatedText += text;
            onChunk(text);
            return;
          }
          if (segmentBaseText.startsWith(segmentBuffer) && segmentBuffer.length < segmentBaseText.length) return;
          const overlapWindow = Math.min(segmentBaseText.length, 6000);
          if (segmentBuffer.length < overlapWindow) return;
          const addition = mergeContinuation(segmentBaseText, segmentBuffer);
          if (addition) {
            accumulatedText += addition;
            onChunk(addition);
          }
          segmentPrefixResolved = true;
        }, undefined, undefined, false, {
          deadlineAt,
          avoidPairs: Array.from(usedPairs),
        });
      } catch (error: any) {
        segmentError = error;
        lastError = error;
      }

      if (activePair) usedPairs.add(activePair);
      if (segmentError?.blockedResponse) throw segmentError;
      if (!segmentPrefixResolved && segmentBuffer) {
        const addition = mergeContinuation(segmentBaseText, segmentBuffer);
        if (addition) {
          accumulatedText += addition;
          onChunk(addition);
        }
        segmentPrefixResolved = true;
      }

      if (segmentCompleted) {
        completed = true;
        break;
      }
      if (!segmentBuffer.trim() || accumulatedText.length === segmentBaseText.length) {
        throw segmentError || new Error('لم يصل نص جديد أثناء محاولة استكمال المستند.');
      }
      if (continuationCount >= maxContinuations) {
        const incompleteError: any = new Error(`لم تكتمل الإجابة بعد ${maxContinuations} محاولات استكمال؛ لم تصل علامة اكتمال المستند.`);
        incompleteError.status = 502;
        incompleteError.statusCode = 502;
        incompleteError.cause = lastError;
        throw incompleteError;
      }

      console.info('[counter-brief] continuing incomplete output', {
        finishReason: finishReason || 'UNKNOWN',
        generatedCharacters: accumulatedText.length,
        continuationCount: continuationCount + 1,
        providerModel: activePairLabel || 'unknown',
        changedConnection: Boolean(previousPair && activePair && previousPair !== activePair),
        previousRequestFailed: Boolean(segmentError),
      });
      previousPair = activePair;
      continuationCount += 1;
    }

    if (!completed) {
      const incompleteError: any = new Error('انتهى الوقت المتاح قبل اكتمال المستند القانوني.');
      incompleteError.status = 504;
      incompleteError.statusCode = 504;
      throw incompleteError;
    }
    const finalText = accumulatedText.trim();
    if (options.legalResearch) {
      const verificationReport = await verifyLegalReferences(finalText);
      if (verificationReport) {
        onChunk?.(verificationReport);
        return `${finalText}${verificationReport}`;
      }
    }
    return finalText;
  }

  while (continuationCount <= maxContinuations && Date.now() < deadlineAt) {
    let activePair = '';
    let activePairLabel = '';
    let segmentResult: any;
    try {
      segmentResult = await executeWithKeyRotation(async (ai, key, model) => {
        activePair = key === 'openrouter' ? `openrouter::${model}` : `${key}::${model}`;
        activePairLabel = `${key === 'openrouter' ? 'OpenRouter' : 'Gemini'} / ${model}`;
        // Search is available only on Gemini; OpenRouter is generation-only.
        const providerSearchEnabled = options.legalResearch &&
          key !== 'openrouter' &&
          process.env.GEMINI_ENABLE_GOOGLE_SEARCH === 'true';
        const segmentPrompt = makeContinuationPrompt(providerSearchEnabled, accumulatedText);
        const response = await ai.models.generateContent({
          model,
          contents: segmentPrompt,
          config: {
            systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
            temperature: 0.15,
            maxOutputTokens: 32768,
            ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
          },
        });
        const rawText = typeof response.text === 'string' ? response.text : '';
        const finishReason = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
        if (!rawText.trim()) {
          const emptyError: any = new Error(`أعاد مزود الذكاء الاصطناعي نصاً فارغاً (finishReason: ${finishReason || 'UNKNOWN'}).`);
          emptyError.status = 503;
          emptyError.statusCode = 503;
          throw emptyError;
        }
        if (isBlockedFinishReason(finishReason)) {
          const blockedError: any = new Error(`توقف النموذج بسبب قيد محتوى (finishReason: ${finishReason}).`);
          blockedError.status = 502;
          blockedError.statusCode = 502;
          blockedError.blockedResponse = true;
          throw blockedError;
        }
        const markerIndex = rawText.indexOf(completionMarker);
        return {
          text: markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText,
          completed: markerIndex >= 0,
          finishReason,
        };
      }, undefined, undefined, false, {
        deadlineAt,
        avoidPairs: Array.from(usedPairs),
      });
    } catch (error: any) {
      lastError = error;
      if (error?.blockedResponse) throw error;
      if (activePair) usedPairs.add(activePair);
      throw error;
    }

    if (activePair) usedPairs.add(activePair);
    const addition = mergeContinuation(accumulatedText, segmentResult.text || '');
    accumulatedText += addition;
    if (segmentResult.completed) {
      const finalText = accumulatedText.trim();
      if (options.legalResearch) {
        const verificationReport = await verifyLegalReferences(finalText);
        return `${finalText}${verificationReport}`;
      }
      return finalText;
    }
    if (!addition.trim()) throw new Error(`لم يصل نص جديد أثناء الاستكمال (finishReason: ${segmentResult.finishReason || 'UNKNOWN'}).`);
    if (continuationCount >= maxContinuations) {
      const incompleteError: any = new Error(`لم تكتمل الإجابة بعد ${maxContinuations} محاولات استكمال؛ لم تصل علامة اكتمال المستند.`);
      incompleteError.status = 502;
      incompleteError.statusCode = 502;
      incompleteError.cause = lastError;
      throw incompleteError;
    }
    console.info('[counter-brief] continuing incomplete output', {
      finishReason: segmentResult.finishReason || 'UNKNOWN',
      generatedCharacters: accumulatedText.length,
      continuationCount: continuationCount + 1,
      providerModel: activePairLabel || 'unknown',
      changedConnection: Boolean(previousPair && activePair && previousPair !== activePair),
    });
    previousPair = activePair;
    continuationCount += 1;
  }

  const incompleteError: any = new Error('انتهى الوقت المتاح قبل اكتمال المستند القانوني.');
  incompleteError.status = 504;
  incompleteError.statusCode = 504;
  throw incompleteError;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }


  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const {
      courtType,
      circuit,
      briefType,
      judicialWorkType,
      customJudicialWorkType,
      effectiveWorkType,
      clientRole,
      clientName,
      opponentName,
      caseNumber,
      sessionDate,
      facts,
      defenses,
      requests,
      customInstructions,
      vaultContext,
    } = body || {};

    if (!facts || !facts.trim()) {
      return res.status(400).json({ error: 'يرجى كتابة وقائع الدعوى.' });
    }

    rateLimit(req, 'gemini-counter-brief', 8, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    limitBodyString(facts, 200000, 'الوقائع');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');
    if (typeof vaultContext !== 'string' || !vaultContext.includes('[بصمة أسلوب المحامي')) {
      const err: any = new Error('لم يتم العثور على نموذج شخصي من خزانة هذا الحساب. لم يبدأ التوليد ولم يُخصم رصيد؛ أضف أو استعد نماذجك الشخصية أولاً.');
      err.statusCode = 400;
      throw err;
    }

    const finalWorkType =
      (customJudicialWorkType && customJudicialWorkType.trim()) ||
      (effectiveWorkType && effectiveWorkType.trim()) ||
      (briefType && briefType.trim()) ||
      '';
    const workTypeInstruction = finalWorkType
      ? `نوع المستند المطلوب من المحامي: ${finalWorkType}. التزم بهذا النوع.`
      : 'نوع المستند غير محدد مسبقاً: حدّد داخلياً أنسب نوع مستند قانوني للرد على المادة المنقولة (مذكرة رد/دفاع، عريضة/صحيفة دعوى، صحيفة طعن، حافظة مستندات، إنذار أو غير ذلك) بناءً على الغرض والطلبات والوقائع، ولا تفترض تلقائياً أنها مذكرة دفاع.';

    const legalResearch = /(?:بحث\s+(?:قانوني|عن|في)|تحقق\s+(?:من|من صحة)|مصادر\s+(?:رسمية|موثوقة)|أحكام\s+(?:النقض|الإدارية العليا)|المحكمة\s+الإدارية\s+العليا|رقم\s+طعن|رقم\s+الطعن|مبدأ\s+قضائي|سابقة\s+قضائية|نص\s+المادة|المادة\s+رقم|قانون\s+رقم|آخر\s+تعديل|أحدث\s+تعديل)/i.test([facts, defenses, requests, customInstructions].filter(Boolean).join(' '));

    const prompt = `[لغة الإخراج والتنسيق الإلزامية — أولوية قصوى]: اكتب المستند القانوني كله باللغة العربية فقط، بما في ذلك العناوين والديباجة وأي ملاحظات تحريرية. يُحظر إدراج كلمات أو تعليمات تنسيق باللغة الإنجليزية داخل المستند، مثل Centered Title أو Center Align أو Heading أو Bold أو Justify أو أي وصف لطريقة التنسيق. لا تكتب تعليمات التنسيق كنص؛ طبّق شكل العناوين وترتيبها مباشرةً باستخدام النص العربي وحده. احتفظ بالمصطلح الأجنبي فقط إذا كان اسماً رسمياً أو اختصاراً ضرورياً ورد في وقائع القضية، وليس لوصف التنسيق. لا تغيّر الديباجة العربية أو أسلوبها المستخلص من خزنة المحامي؛ المطلوب تنسيقها بالعربية لا ترجمتها أو شرحها. [مهمة إعداد وصياغة قانونية شاملة]: ${workTypeInstruction} المحكمة: ${courtType || 'المحكمة المختصة'} الدائرة: ${circuit || ''} الصفة التي حددها المحامي: ${clientRole || 'غير محددة صراحةً؛ لا تفترض أن الموكل هو المدعى عليه، واستدل من الوقائع فقط إذا كانت واضحة، وإلا نبّه إلى ضرورة تحديد الصفة'} (${clientName ? `السيد / ${clientName}` : 'الموكل'}) الخصم: ${opponentName || 'الخصم'} رقم الدعوى: ${caseNumber || ''} الجلسة: ${sessionDate || ''} الوقائع والمعلومات الحالية: ${facts} ${defenses ? `أوجه الدفاع والدفوع التي أدخلها المحامي:\n${defenses}\n` : ''} ${requests ? `الطلبات التي أدخلها المحامي:\n${requests}\n` : ''} ${customInstructions ? `[تعليمات إضافية]:\n${customInstructions}\n` : ''} ${vaultContext ? `\n[خزانة المحامي — أسلوب وبنية فقط، لا تستورد منها وقائع أو أرقاماً]:\n${vaultContext}\n` : ''} قبل الصياغة نفّذ داخلياً: - فحص اكتمال الوقائع وتحديد أي معلومات جوهرية ناقصة. - تحديد نوع المستند القانوني المطلوب أو الأنسب أولاً، وعدم افتراض أن كل رد يجب أن يكون مذكرة دفاع. - تحديد التكييف القانوني الأرجح وأي تكييف بديل ذي أثر. - استخراج أقوى الدفوع والأسانيد المرتبطة بالوقائع. - فحص الصفة والمصلحة والاختصاص والإجراءات والمواعيد متى كانت ذات صلة. - مطابقة كل دفع مع الواقعة والمستند/الدليل المتاح. - تحديد التناقضات أو نقاط الضعف إن وجدت. - ترتيب النقاط بحسب أثرها القانوني والإثباتي: معالجة الجوهرية، ودمج المساندة، وعدم إنشاء رد مستقل على الهامشية إلا إذا كان لها أثر حقيقي. - بناء الطلبات الختامية من النتيجة التي انتهى إليها التحليل فقط، ومطابقة كل طلب صراحةً مع طلبات المحامي ووقائع القضية والدفوع والأسباب والنتيجة النهائية. - الالتزام الصارم بنطاق الطلبات التي أدخلها المحامي: لا تضف أو تحذف أو تستبدل أو توسّع طلباً قضائياً من تلقاء نفسك. يجوز تحسين الصياغة وترتيب الطلبات المحددة فقط مع الحفاظ على مضمونها. - إذا ظهر طلب إضافي قد يكون مهماً، فاذكره في تنبيه منفصل للمحامي ولا تدرجه في الطلبات الختامية إلا إذا فوّضك صراحةً في تحديد الطلبات أو وافق عليه. - إذا لم يحدد المحامي طلباته وتركها للنظام صراحةً، فاقترح الطلبات الضرورية فقط التي تسندها الوقائع والمستندات والتكييف القانوني، ولا تفترض تفويضاً لم يمنحه. - راجع أن كل طلب ختامي يطابق طلباً حدده المحامي أو تفويضاً صريحاً منه، وأنه لم يُحذف أي طلب أدخله. لا تعتبر احتمال أهمية طلب إضافي إذناً بإدراجه تلقائياً. [التزام حرفي بالقالب — Strict Pattern Base / أولوية قصوى]: اعتبر النص المرجعي الفعلي المرفق من خزنة هذا الحساب هو القالب البنيوي الإلزامي للمستند متى كان متاحاً، وليس خياراً استرشادياً. طابق هيكل النموذج وترتيب أقسامه وعناوينه وتسلسل الدفوع والبنود والمصطلحات القانونية وطريقة الترقيم والديباجة والخاتمة والترويسة بقدر انطباقها على القضية الحالية. لا تحذف أو تضف أو تعيد ترتيب قسم أو دفع أو بند ولا تستبدل مصطلحاً قانونياً خاصاً بالقالب بتعبير عام لمجرد تحسين الأسلوب؛ عدّل فقط ما تفرضه وقائع القضية الحالية أو نوع المستند المطلوب، مع الحفاظ على كل عنصر بنيوي صالح. إذا كان القالب لا يتضمن قسماً لازماً بطبيعة العمل الحالي، أضف الحد الضروري فقط ولا تعِد تصميم بقية الهيكل. تعامل مع وقائع الدعوى الحالية والطلبات والدفوع التي أدخلها المحامي باعتبارها مصدر المحتوى الموضوعي، ومع القالب باعتباره مصدر الهيكل والأسلوب. لا تنقل أي وقائع أو أسماء أو أرقام أو تواريخ أو طلبات تخص القضية المرجعية. اكتب بصوت المحامي المصري الممارس وببصمته المهنية، لا بصيغة مساعد ذكاء اصطناعي ولا بصيغة اقتراحات أو توصيات. [Zero Chatter — منع الثرثرة]: أخرج المستند القانوني وحده، وابدأ فوراً من أول سطر في الديباجة القانونية كما ورد نمطها في القالب؛ ممنوع أي مقدمة أو تحية أو تمهيد أو شرح لطريقة العمل أو عبارة مثل «إليك الصياغة» أو أي خاتمة محادثية. لا تضع ملاحظات خارج المستند إلا عند ضرورة تحقق قانوني محددة، وعندها افصلها بوضوح عن نص المستند ولا تخلطها بالديباجة أو الطلبات الختامية. استخلص الدفوع والتحليل للقضية الحالية استقلالاً، ولا تنقل وقائع القضية المرجعية أو أسماء أطرافها أو أرقامها أو تواريخها أو طلباتها الخاصة. يجوز استخدام اسم المكتب والترويسة والتوقيع الثابت الوارد في النموذج المرجعي إذا كان واضحاً، مع عدم اختراع بيانات أو نقل بيانات القضية القديمة. لا تدّعِ أن المرجع غير موجود؛ النص المرجعي مرفق داخل سياق الخزانة. اعتمد في مضمون المستند حصراً على مدخلات القضية الحالية ومستنداتها والطلبات التي حددها المستخدم. لا تفرض هيكل نوع مستند آخر؛ التزم حرفياً بنوع العمل القضائي المطلوب حالياً، سواء كان صحيفة دعوى أو مذكرة أو إعادة إعلان أو إنذاراً أو غير ذلك. إذا لم يوجد في الخزنة نموذج من النوع نفسه، استخدم أقرب مرجع اختير وفق نوع المستند والفرع القانوني وجهة القضاء، مع الاقتداء بأسلوب المحامي وترويسته وبنائه العام وتكييف هيكل المستند ليتفق مع نوع العمل الحالي. لا تذكر للمستخدم أنك استخدمت الخزنة أو تشرح آلية استخلاص البصمة. لا تختصر نقطة مؤثرة، ولا تُطِل في نقطة لا تحتاج إلى تفصيل؛ اجعل التفصيل تابعاً لحاجة القضية. لا تفصل «الأسانيد القانونية» كقسم مستقل؛ ضع القاعدة القانونية داخل سياق الحجة في موضعها الطبيعي. لا تضف واقعة أو مستنداً أو اسماً أو تاريخاً غير موجود. إذا كانت نقطة جوهرية تحتاج تحققاً، ضع تنبيهاً واضحاً للمحامي بدلاً من اختلاقها. لا تذكر حكماً أو رقم طعن أو مادة قانونية إلا إذا كانت موثوقة في السياق المتاح؛ وإلا اذكر أن التحقق مطلوب. وفي النهاية راجع المسودة داخلياً مرة أخرى بحثاً عن أي واقعة أو مستند أو دفع أو طلب أو تناقض تم إغفاله قبل إخراج النص النهائي. لا تعتبر المذكرة مكتملة إذا انتهى الإخراج قبل إتمام بنيتها المطلوبة؛ أكمل جميع الأقسام اللازمة لنوع المستند، ولا تتوقف عند الملخص أو منتصف الحجة أو قبل الطلبات الختامية. إذا كان النص طويلاً، حافظ على نفس مستوى التحليل وأكمل حتى النهاية بدلاً من اختزال الأجزاء الأخيرة.`;

    if (body?.stream === true) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      // Keep the Vercel stream active while Gemini prepares its first token.
      // Otherwise a slow first token can surface in the browser as
      // "Failed to fetch" when the upstream connection is terminated.
      res.write(JSON.stringify({ type: 'start' }) + '\n');
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'keepalive' }) + '\n');
        }
      }, 5000);

      let streamedAny = false;
      const writeChunk = (text: string) => {
        if (text) {
          streamedAny = true;
          res.write(JSON.stringify({ type: 'chunk', text }) + '\n');
        }
      };
      try {
        // Forward actual model chunks as they arrive. The generator keeps
        // handling continuation internally while the client sees live output.
        await generateDeepLegalResponse(prompt, writeChunk, { legalResearch });
        if (!streamedAny) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
        await consumeOperation(req, 'gemini-operation');
        res.write(JSON.stringify({ type: 'done' }) + '\n');
        return res.end();
      } catch (streamErr: any) {
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'error', error: streamErr?.message || 'فشلت الاستجابة المتدفقة.' }) + '\n');
          return res.end();
        }
        return;
      } finally {
        clearInterval(heartbeat);
      }
    }

    const resultText = await generateDeepLegalResponse(prompt, undefined, { legalResearch });
    if (!resultText.trim()) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
    const usage = await consumeOperation(req, 'gemini-operation');
    return res.json({ result: resultText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/counter-brief:', err);
    const statusCode = Number(err?.statusCode);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    if (!res.headersSent) {
      if (err?.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      return res.status(status).json({ error: err.message || 'فشلت الصياغة.' });
    }
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', error: err.message || 'فشلت الصياغة.' }) + '\n');
      return res.end();
    }
  }
}
