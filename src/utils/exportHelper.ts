import JSZip from 'jszip';
import { chooseBestLegalDocTemplate, classifyLegalDocument, getLegalDocTemplate, getLegalDocTemplates, type LegalDocTemplate } from './legalTemplateService.ts';

export interface LegalWordExportOptions {
  userId?: string;
  templateMode?: 'auto' | 'manual';
  templateId?: string;
  courtType?: string;
  workType?: string;
  facts?: string;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeGenericWordBlob(content: string): Blob {
  const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const paragraphs = content.split(/\n\s*\n/).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`).join('');
  const htmlContent = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><title>المستند القضائي</title>
    <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
    <style>@page{size:A4;margin:2.5cm 2.5cm 2.5cm 2.5cm;mso-page-orientation:portrait}body{font-family:'Traditional Arabic','Amiri',Arial,sans-serif;font-size:16pt;direction:rtl;text-align:justify;line-height:1.8;color:#000}p{margin-bottom:12pt;line-height:1.8;text-align:justify}h1,h2,h3{font-family:'Traditional Arabic',Arial,sans-serif;font-weight:bold;text-align:center;color:#000}table{border-collapse:collapse;width:100%;margin-bottom:12pt;direction:rtl}th,td{border:1px solid #333;padding:8pt;text-align:right;font-size:14pt}th{background:#f2f2f2;font-weight:bold}</style></head><body>${paragraphs}</body></html>`;
  return new Blob(['\ufeff', htmlContent], { type: 'application/msword;charset=utf-8' });
}

function textOfParagraph(paragraph: Element): string {
  return Array.from(paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't'))
    .map((node) => node.textContent || '').join('').trim();
}

function isHeadingLike(text: string, paragraph: Element): boolean {
  const pPr = paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'pPr')[0];
  const style = pPr?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'pStyle')[0]?.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'val') || '';
  const align = pPr?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'jc')[0]?.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'val') || '';
  const rPr = paragraph.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'rPr')[0];
  const bold = !!rPr?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'b').length;
  return /title|heading|subtitle/i.test(style) || (align === 'center' && bold) || (text.length > 0 && text.length < 65 && /^(الوقائع|الدفاع|الدفوع|أولاً|ثانياً|ثالثاً|الطلبات|بناءً عليه|لذلك|الموضوع|مذكرة|أسباب الطعن|الطلبات الختامية)/.test(text));
}

function isGeneratedHeading(line: string): boolean {
  const trimmed = line.trim();
  return !!trimmed && trimmed.length < 80 && /^(الموضوع|مذكرة|الوقائع|الدفاع|الدفوع|أولاً|ثانياً|ثالثاً|رابعاً|الطلبات|بناءً عليه|لذلك|أسباب الطعن|الطلبات الختامية|أمام محكمة)/.test(trimmed);
}

function replaceDocxBodyXml(documentXml: string, content: string): string {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(documentXml, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length) throw new Error('ملف وورد القالب يحتوي على XML غير صالح.');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = xmlDoc.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw new Error('لم يتم العثور على متن المستند داخل قالب وورد.');
  const direct = Array.from(body.children) as Element[];
  const sectPr = direct.find((el) => el.localName === 'sectPr') || null;
  const isCaseStart = (text: string) => /مذكرة\s+بدفاع|صحيفة\s+دعوى|أمام\s+محكمة|الوقائع|أسباب\s+الطعن|الموضوع\s*[:：]|المدعي\s*[:：]|المدعى\s+عليه/.test(text);
  const getText = (el: Element) => Array.from(el.getElementsByTagNameNS(ns, 't')).map((n) => n.textContent || '').join('').replace(/\s+/g, ' ').trim();
  const directParagraphs = direct.filter((el) => el.localName === 'p');
  const firstCaseIndex = directParagraphs.findIndex((p) => isCaseStart(getText(p)));
  // Keep the original letterhead and every layout element (tables, borders, section settings,
  // headers/footers). Only replace the case-text paragraphs in the body, retaining paragraph/run styles.
  let contentParagraphs = firstCaseIndex >= 0 ? directParagraphs.slice(firstCaseIndex) : directParagraphs.filter((p) => getText(p).length > 0);
  if (!contentParagraphs.length) contentParagraphs = directParagraphs.slice(-1);
  if (!contentParagraphs.length) throw new Error('القالب لا يحتوي على فقرات متن قابلة للاستبدال.');
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const createParagraph = (source: Element, rawLine: string) => {
    const p = xmlDoc.createElementNS(ns, 'w:p');
    const pPr = Array.from(source.children).find((el) => el.localName === 'pPr');
    if (pPr) p.appendChild(pPr.cloneNode(true));
    const sourceRun = Array.from(source.getElementsByTagNameNS(ns, 'r')).find((r) => r.getElementsByTagNameNS(ns, 't').length > 0);
    const run = xmlDoc.createElementNS(ns, 'w:r');
    const rPr = sourceRun ? Array.from(sourceRun.children).find((el) => el.localName === 'rPr') : null;
    if (rPr) run.appendChild(rPr.cloneNode(true));
    const t = xmlDoc.createElementNS(ns, 'w:t');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    t.textContent = rawLine;
    run.appendChild(t); p.appendChild(run); return p;
  };
  const headingSource = contentParagraphs.find((p) => /title|heading/i.test(p.getAttribute('style') || '') || /موضوع|مذكرة|الطلبات|الوقائع/.test(getText(p))) || contentParagraphs[0];
  const bodySource = contentParagraphs.find((p) => p !== headingSource) || contentParagraphs[0];
  const anchor = contentParagraphs[0];
  const parent = anchor.parentNode;
  if (!parent) throw new Error('تعذر تحديد موضع متن المستند في القالب.');
  const newParagraphs = lines.map((line) => createParagraph((/^(الموضوع|مذكرة|الوقائع|الدفاع|الدفوع|أولاً|ثانياً|ثالثاً|رابعاً|الطلبات|بناءً عليه|لذلك|أسباب الطعن|أمام محكمة)/.test(line.trim()) ? headingSource : bodySource), line));
  // Replace only the detected main-body paragraph range; don't clear w:body or rebuild the document.
  const last = contentParagraphs[contentParagraphs.length - 1];
  const next = last.nextSibling;
  for (const p of contentParagraphs) p.remove();
  for (const p of newParagraphs) parent.insertBefore(p, next && next.parentNode === parent ? next : sectPr);
  const serialized = new XMLSerializer().serializeToString(xmlDoc);
  if (!serialized || !serialized.includes('document')) throw new Error('تعذر إعادة إنشاء محتوى مستند وورد.');
  return serialized;
}

async function makeTemplateDocxBlob(content: string, templateBlob: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(templateBlob);
  const documentEntry = zip.file('word/document.xml');
  if (!documentEntry) throw new Error('قالب وورد لا يحتوي على ملف document.xml صالح.');
  const originalXml = await documentEntry.async('string');
  const updatedXml = replaceDocxBodyXml(originalXml, content);
  zip.file('word/document.xml', updatedXml);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** Exports using a stored original .docx template when available; otherwise uses the legacy generic .doc export. */
export async function exportLegalDocToWord(content: string, baseTitle = 'صياغة_قضائية', options: LegalWordExportOptions = {}): Promise<void> {
  if (!content?.trim()) return;
  const cleanTitle = baseTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) || 'صياغة_قضائية';
  const userId = options.userId;
  if (userId && options.templateMode !== undefined) {
    try {
      let template: LegalDocTemplate | null = null;
      if (options.templateMode === 'manual' && options.templateId) {
        template = await getLegalDocTemplate(options.templateId, userId);
      } else if (options.templateMode === 'manual' && !options.templateId) {
        window.alert('اختَر قالب وورد من القائمة أولًا، أو غيّر الاختيار إلى التنسيق التلقائي.');
        return;
      } else if (options.templateMode === 'auto') {
        const templates = await getLegalDocTemplates(userId);
        const inferred = classifyLegalDocument(cleanTitle, `${content.slice(0, 12000)}\n${options.facts || ''}`);
        template = chooseBestLegalDocTemplate(templates, {
          courtType: options.courtType || inferred.courtType,
          workType: options.workType || inferred.workType,
          facts: `${content.slice(0, 12000)}\n${options.facts || ''}`,
        });
        // In automatic mode, a saved template should not be silently ignored just because
        // metadata scoring found no exact match (e.g. "مذكرة مدني" vs "مذكرة بدفاع").
        if (!template && templates.length) template = templates[0];
      }
      if (template) {
        const blob = await makeTemplateDocxBlob(content, template.blob);
        downloadBlob(blob, `${cleanTitle}_${Date.now()}.docx`);
        return;
      }
      window.alert(options.templateMode === 'manual'
        ? 'تعذر العثور على القالب المختار أو لا يوجد قالب محفوظ صالح. لم يتم تنزيل مستند عام بدلًا منه.'
        : 'لم يتم العثور على قالب Word محفوظ لهذا الحساب. احفظ قالبًا أولًا ثم أعد التصدير.');
      return;
    } catch (error) {
      console.error('Template-based Word export failed:', error);
      window.alert('فشل تطبيق قالب Word الأصلي، لذلك أوقفنا التصدير بدلًا من تنزيل مستند عادي لا يطابق القالب.');
      return;
    }
  }
  downloadBlob(makeGenericWordBlob(content), `${cleanTitle}_${Date.now()}.doc`);
}
