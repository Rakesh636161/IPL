import React, { useState } from 'react';
import { User } from 'lucide-react';

interface PlayerImageProps {
  src: string;
  alt: string;
  className?: string;
}

export const PlayerImage: React.FC<PlayerImageProps> = ({ src, alt, className = '' }) => {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-slate-800 via-slate-900 to-[#060B18] text-amber-400/80 ${className}`}
        aria-label={alt}
      >
        <User className="w-10 h-10 mb-1" />
        <span className="text-[11px] text-slate-400 font-medium px-2 text-center truncate max-w-full">
          {alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  );
};
