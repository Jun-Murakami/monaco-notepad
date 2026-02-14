import i18n from '../i18n';

export interface MessageCode {
  code: string;
  args?: Record<string, string | number>;
}

export function translateMessageCode(message: MessageCode): string {
  return i18n.t(message.code, message.args || {});
}

export function isMessageCode(value: unknown): value is MessageCode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as MessageCode).code === 'string'
  );
}
