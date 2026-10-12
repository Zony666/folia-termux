import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// src/library/suites/grid/account/ProviderPhoneLoginPanel.tsx
// 手机号 + 短信验证码登录表单，是不扫码的登录路径。弹窗本身是纯展示的，这块自己持有输入与倒计时状态，
// 发码 / 提交都经回调交给外层（surface → controller）；出错文案由外层按 reason 翻好再传进来，这里不碰 i18n。

export type ProviderPhoneLoginLabels = {
    countryCode: string;
    phone: string;
    phonePlaceholder: string;
    code: string;
    codePlaceholder: string;
    sendCode: string;
    resend: string;
    sending: string;
    submit: string;
    submitting: string;
};

type ProviderPhoneLoginPanelProps = {
    labels: ProviderPhoneLoginLabels;
    /** 失败文案：外层负责把错误里的 reason 翻成当前语言。 */
    formatError: (error: unknown) => string;
    onSendCode: (phone: string, countryCode: string) => Promise<void>;
    onSubmit: (phone: string, code: string, countryCode: string) => Promise<void>;
};

/** 发码后的重发冷却秒数；与短信通道的实际限流取更保守的一个。 */
const RESEND_COOLDOWN_SECONDS = 60;

const INPUT_CLASS = 'rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-green-500/60 placeholder:text-white/25';
const LABEL_CLASS = 'mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-45';

const ProviderPhoneLoginPanel = ({ labels, formatError, onSendCode, onSubmit }: ProviderPhoneLoginPanelProps) => {
    const [countryCode, setCountryCode] = useState('86');
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [sending, setSending] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [cooldown, setCooldown] = useState(0);
    const timerRef = useRef<number | null>(null);

    // 卸载时一定要清掉倒计时定时器：弹窗收起后它还在跑会去改已卸载组件的状态。
    useEffect(() => () => { if (timerRef.current !== null) window.clearInterval(timerRef.current); }, []);

    const startCooldown = () => {
        setCooldown(RESEND_COOLDOWN_SECONDS);
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = window.setInterval(() => {
            setCooldown(current => {
                if (current <= 1) {
                    if (timerRef.current !== null) window.clearInterval(timerRef.current);
                    timerRef.current = null;
                    return 0;
                }
                return current - 1;
            });
        }, 1000);
    };

    const handleSend = async () => {
        const trimmedPhone = phone.trim();
        if (!trimmedPhone) {
            setError(formatError({ phoneLoginReason: 'invalid-phone' }));
            return;
        }
        setSending(true);
        setError(null);
        try {
            await onSendCode(trimmedPhone, countryCode.trim() || '86');
            setSent(true);
            startCooldown();
        } catch (sendError) {
            setError(formatError(sendError));
        } finally {
            setSending(false);
        }
    };

    const handleSubmit = async () => {
        const trimmedPhone = phone.trim();
        const trimmedCode = code.trim();
        if (!trimmedPhone) {
            setError(formatError({ phoneLoginReason: 'invalid-phone' }));
            return;
        }
        if (!trimmedCode) {
            setError(formatError({ phoneLoginReason: 'invalid-captcha' }));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            await onSubmit(trimmedPhone, trimmedCode, countryCode.trim() || '86');
            // 成功时外层会收起弹窗，这里不必再改本地状态。
        } catch (submitError) {
            setError(formatError(submitError));
            setSubmitting(false);
        }
    };

    const resendLabel = cooldown > 0
        ? `${labels.resend} (${cooldown})`
        : (sent ? labels.resend : labels.sendCode);

    return (
        <div className="w-full max-w-xs mx-auto text-left" style={{ color: 'var(--text-primary)' }}>
            <div className="mb-3">
                <label className={LABEL_CLASS} style={{ color: 'var(--text-secondary)' }}>{labels.phone}</label>
                <div className="flex gap-2">
                    <input
                        value={countryCode}
                        onChange={event => setCountryCode(event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                        inputMode="numeric"
                        aria-label={labels.countryCode}
                        className={`${INPUT_CLASS} w-16 shrink-0 text-center`}
                    />
                    <input
                        value={phone}
                        onChange={event => setPhone(event.target.value.replace(/[^\d]/g, ''))}
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder={labels.phonePlaceholder}
                        className={`${INPUT_CLASS} min-w-0 flex-1`}
                    />
                </div>
            </div>
            <div className="mb-4">
                <label className={LABEL_CLASS} style={{ color: 'var(--text-secondary)' }}>{labels.code}</label>
                <div className="flex gap-2">
                    <input
                        value={code}
                        onChange={event => setCode(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder={labels.codePlaceholder}
                        className={`${INPUT_CLASS} min-w-0 flex-1`}
                    />
                    <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={sending || cooldown > 0}
                        className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-40"
                    >
                        {sending ? labels.sending : resendLabel}
                    </button>
                </div>
            </div>
            {error && (
                <p className="mb-3 break-words text-[11px] leading-snug text-red-400">{error}</p>
            )}
            <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-green-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-600 disabled:cursor-default disabled:opacity-60"
            >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {submitting ? labels.submitting : labels.submit}
            </button>
        </div>
    );
};

export default ProviderPhoneLoginPanel;
