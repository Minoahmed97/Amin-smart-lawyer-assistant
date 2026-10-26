import Groq from "groq-sdk";

// تهيئة عميل Groq باستخدام مفتاح البيئة
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function groqChatCompletion(base64Image: string, promptText: string): Promise<string> {
  try {
    // التأكد من ضبط النموذج الصحيح للرؤية المدعوم من Groq
    const modelName = process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";

    const response = await groq.chat.completions.create({
      model: modelName,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText || "Extract all Arabic text from this document accurately.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    });

    const resultText = response.choices[0]?.message?.content;
    if (!resultText) {
      throw new Error("لم يتم استلام نص صالح من نموذج Groq Vision.");
    }

    return resultText;
  } catch (error: any) {
    console.error("Groq OCR Error details:", error);
    
    // رسالة خطأ واضحة باللغة العربية للـ Logs
    const errorMessage = error?.message || error?.error?.message || "خطأ غير معروف في خدمة Groq";
    throw new Error(`رفض Groq طلب OCR أو النموذج المحدد. تأكد من صحة نموذج الرؤية ومفتاح الـ API. التفاصيل: ${errorMessage}`);
  }
}
