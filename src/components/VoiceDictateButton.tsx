import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, AlertCircle } from 'lucide-react';

interface VoiceDictateButtonProps {
  onTranscript: (text: string) => void;
  className?: string;
  lang?: string;
  title?: string;
}

export const VoiceDictateButton: React.FC<VoiceDictateButtonProps> = ({
  onTranscript,
  className = '',
  lang = 'ar-EG',
  title = 'إملاء صوتي فوري',
}) => {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = lang;

      recognition.onresult = (event: any) => {
        let transcriptChunk = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            transcriptChunk += event.results[i][0].transcript + ' ';
          }
        }
        if (transcriptChunk.trim()) {
          onTranscriptRef.current(transcriptChunk.trim());
        }
      };

      recognition.onerror = (event: any) => {
        console.warn('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          setErrorMessage('إذن الميكروفون مرفوض.');
        } else if (event.error === 'network') {
          setErrorMessage('خطأ اتصال بالشبكة.');
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } catch (e) {
      console.warn('Failed to initialize speech recognition:', e);
      setIsSupported(false);
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
    };
  }, [lang]);

  const toggleListening = async () => {
    setErrorMessage(null);

    if (isListening) {
      try { recognitionRef.current?.stop(); } catch {}
      setIsListening(false);
      return;
    }

    // Request microphone permission before checking SpeechRecognition support.
    // Some Android browsers expose getUserMedia but not the Web Speech API.
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMessage('المتصفح لا يتيح طلب إذن الميكروفون. افتح التطبيق من متصفح Chrome عبر اتصال HTTPS وتحقق من أذونات الموقع.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      if (!isSupported || !recognitionRef.current) {
        setErrorMessage('تم الوصول إلى الميكروفون، لكن هذا المتصفح لا يدعم تحويل الكلام إلى نص. استخدم Google Chrome محدّثًا.');
        return;
      }

      recognitionRef.current.start();
      setIsListening(true);
    } catch (err: any) {
      console.warn('Speech start error:', err);
      const errorName = String(err?.name || '');
      if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError' || errorName === 'SecurityError') {
        setErrorMessage('إذن الميكروفون مرفوض. اسمح للمتصفح باستخدام الميكروفون من إعدادات الموقع ثم أعد المحاولة.');
      } else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
        setErrorMessage('لم يتم العثور على ميكروفون متاح على الجهاز.');
      } else if (errorName === 'NotReadableError' || errorName === 'TrackStartError') {
        setErrorMessage('الميكروفون مستخدم بواسطة تطبيق آخر أو يتعذر تشغيله حاليًا.');
      } else if (String(err?.message || '').toLowerCase().includes('already started')) {
        setErrorMessage('الإملاء الصوتي يعمل بالفعل.');
      } else {
        setErrorMessage('تعذر تشغيل الإملاء الصوتي. تحقق من إذن الميكروفون واتصال الإنترنت ثم حاول مجددًا.');
      }
      setIsListening(false);
    }
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={toggleListening}
        className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border shadow-sm ${
          isListening
            ? 'bg-rose-600/30 text-rose-300 border-rose-500 animate-pulse ring-2 ring-rose-500/50'
            : 'bg-slate-800/90 text-amber-300 border-amber-500/40 hover:bg-amber-950/50 hover:border-amber-400 hover:text-amber-200'
        } ${className}`}
        title={isListening ? 'إيقاف الإملاء الصوتي' : title}
      >
        {isListening ? (
          <>
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
            <MicOff className="w-3.5 h-3.5 text-rose-400" />
            <span>جارٍ الاستماع... (تحدث)</span>
          </>
        ) : (
          <>
            <Mic className="w-3.5 h-3.5 text-amber-400" />
            <span>إملاء صوتي</span>
          </>
        )}
      </button>

      {errorMessage && (
        <div className="absolute top-full mt-1.5 right-0 z-30 bg-rose-950 border border-rose-700 text-rose-200 text-[11px] p-2 rounded-lg shadow-xl whitespace-nowrap flex items-center gap-1">
          <AlertCircle className="w-3 h-3 text-rose-400 flex-shrink-0" />
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-slate-400 hover:text-white mr-1 font-bold"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
