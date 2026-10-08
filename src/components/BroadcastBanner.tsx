import React, { useState, useEffect } from 'react';
import { Megaphone, AlertCircle, Sparkles, X, ArrowLeft, Info } from 'lucide-react';
import { BroadcastAnnouncement, fetchCurrentBroadcast } from '../services/broadcastService.ts';

interface BroadcastBannerProps {
  onOpenSubscribe?: () => void;
  onSwitchTab?: (tab: any) => void;
}

export const BroadcastBanner: React.FC<BroadcastBannerProps> = ({ onOpenSubscribe, onSwitchTab }) => {
  const [broadcast, setBroadcast] = useState<BroadcastAnnouncement | null>(null);
  const [isDismissed, setIsDismissed] = useState<boolean>(false);

  useEffect(() => {
    fetchCurrentBroadcast().then((data) => {
      if (data && data.isActive && data.title) {
        setBroadcast(data);
      }
    });

    const handleUpdate = (e: any) => {
      if (e.detail) {
        setBroadcast(e.detail);
        setIsDismissed(false);
      }
    };

    window.addEventListener('broadcast_updated', handleUpdate);
    return () => window.removeEventListener('broadcast_updated', handleUpdate);
  }, []);

  if (!broadcast || !broadcast.isActive || isDismissed) {
    return null;
  }

  const getTypeStyles = () => {
    switch (broadcast.type) {
      case 'urgent':
        return 'bg-gradient-to-r from-rose-950/90 via-red-900/90 to-amber-950/90 border-rose-500/70 text-rose-100 shadow-rose-900/20';
      case 'offer':
        return 'bg-gradient-to-r from-emerald-950/90 via-teal-900/90 to-emerald-950/90 border-emerald-500/70 text-emerald-100 shadow-emerald-900/20';
      case 'welcome':
        return 'bg-gradient-to-r from-amber-950/90 via-amber-900/80 to-slate-900/90 border-amber-500/60 text-amber-100 shadow-amber-900/20';
      case 'info':
      default:
        return 'bg-gradient-to-r from-blue-950/90 via-slate-900/90 to-indigo-950/90 border-blue-500/60 text-blue-100 shadow-blue-900/20';
    }
  };

  const getIcon = () => {
    switch (broadcast.type) {
      case 'urgent':
        return <AlertCircle className="w-4 h-4 text-rose-300 animate-pulse flex-shrink-0" />;
      case 'offer':
        return <Sparkles className="w-4 h-4 text-emerald-300 flex-shrink-0" />;
      case 'welcome':
        return <Megaphone className="w-4 h-4 text-amber-300 flex-shrink-0" />;
      case 'info':
      default:
        return <Info className="w-4 h-4 text-blue-300 flex-shrink-0" />;
    }
  };

  const handleActionClick = () => {
    if (broadcast.actionUrl === '#packages') {
      if (onSwitchTab) onSwitchTab('packages');
      else if (onOpenSubscribe) onOpenSubscribe();
    } else if (broadcast.actionUrl?.startsWith('http')) {
      window.open(broadcast.actionUrl, '_blank', 'noopener,noreferrer');
    } else if (broadcast.actionUrl) {
      if (onSwitchTab) onSwitchTab(broadcast.actionUrl.replace('#', ''));
    }
  };

  return (
    <div
      className={`mx-3 sm:mx-6 lg:mx-8 my-2.5 p-3 sm:p-3.5 rounded-xl border shadow-lg flex items-center justify-between gap-3 animate-in slide-in-from-top-2 duration-300 ${getTypeStyles()}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="p-1.5 rounded-lg bg-black/20 flex-shrink-0">
          {getIcon()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-xs sm:text-sm text-white">
              {broadcast.title}
            </span>
            <span className="text-[10px] opacity-75 font-mono">
              ({broadcast.updatedAt})
            </span>
          </div>
          <p className="text-xs sm:text-xs leading-relaxed opacity-90 truncate sm:whitespace-normal">
            {broadcast.message}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {broadcast.actionText && (
          <button
            onClick={handleActionClick}
            className="px-3 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white font-bold text-xs border border-white/20 transition-all flex items-center gap-1 cursor-pointer whitespace-nowrap active:scale-95"
          >
            <span>{broadcast.actionText}</span>
            <ArrowLeft className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={() => setIsDismissed(true)}
          className="p-1 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors cursor-pointer"
          title="إغلاق"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
