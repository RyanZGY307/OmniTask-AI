export interface Language {
  code: string;
  bcp47: string;
  englishName: string;
  nativeName: string;
  rtl?: boolean;
}

export const LANGUAGES: Language[] = [
  { code: 'en',    bcp47: 'en-US',    englishName: 'English',              nativeName: 'English' },
  { code: 'zh-CN', bcp47: 'zh-CN',    englishName: 'Chinese (Simplified)', nativeName: '中文（简体）' },
  { code: 'zh-TW', bcp47: 'zh-TW',    englishName: 'Chinese (Traditional)',nativeName: '中文（繁體）' },
  { code: 'ja',    bcp47: 'ja-JP',    englishName: 'Japanese',             nativeName: '日本語' },
  { code: 'ko',    bcp47: 'ko-KR',    englishName: 'Korean',               nativeName: '한국어' },
  { code: 'es',    bcp47: 'es-ES',    englishName: 'Spanish',              nativeName: 'Español' },
  { code: 'fr',    bcp47: 'fr-FR',    englishName: 'French',               nativeName: 'Français' },
  { code: 'de',    bcp47: 'de-DE',    englishName: 'German',               nativeName: 'Deutsch' },
  { code: 'it',    bcp47: 'it-IT',    englishName: 'Italian',              nativeName: 'Italiano' },
  { code: 'pt',    bcp47: 'pt-BR',    englishName: 'Portuguese',           nativeName: 'Português' },
  { code: 'ru',    bcp47: 'ru-RU',    englishName: 'Russian',              nativeName: 'Русский' },
  { code: 'ar',    bcp47: 'ar-SA',    englishName: 'Arabic',               nativeName: 'العربية', rtl: true },
  { code: 'he',    bcp47: 'he-IL',    englishName: 'Hebrew',               nativeName: 'עברית', rtl: true },
  { code: 'th',    bcp47: 'th-TH',    englishName: 'Thai',                 nativeName: 'ไทย' },
  { code: 'vi',    bcp47: 'vi-VN',    englishName: 'Vietnamese',           nativeName: 'Tiếng Việt' },
  { code: 'id',    bcp47: 'id-ID',    englishName: 'Indonesian',           nativeName: 'Bahasa Indonesia' },
  { code: 'ms',    bcp47: 'ms-MY',    englishName: 'Malay',                nativeName: 'Bahasa Melayu' },
  { code: 'hi',    bcp47: 'hi-IN',    englishName: 'Hindi',                nativeName: 'हिन्दी' },
  { code: 'tr',    bcp47: 'tr-TR',    englishName: 'Turkish',              nativeName: 'Türkçe' },
  { code: 'pl',    bcp47: 'pl-PL',    englishName: 'Polish',               nativeName: 'Polski' },
  { code: 'nl',    bcp47: 'nl-NL',    englishName: 'Dutch',                nativeName: 'Nederlands' },
  { code: 'sv',    bcp47: 'sv-SE',    englishName: 'Swedish',              nativeName: 'Svenska' },
  { code: 'da',    bcp47: 'da-DK',    englishName: 'Danish',               nativeName: 'Dansk' },
  { code: 'fi',    bcp47: 'fi-FI',    englishName: 'Finnish',              nativeName: 'Suomi' },
  { code: 'nb',    bcp47: 'nb-NO',    englishName: 'Norwegian',            nativeName: 'Norsk' },
  { code: 'uk',    bcp47: 'uk-UA',    englishName: 'Ukrainian',            nativeName: 'Українська' },
  { code: 'cs',    bcp47: 'cs-CZ',    englishName: 'Czech',                nativeName: 'Čeština' },
  { code: 'el',    bcp47: 'el-GR',    englishName: 'Greek',                nativeName: 'Ελληνικά' },
  { code: 'ro',    bcp47: 'ro-RO',    englishName: 'Romanian',             nativeName: 'Română' },
  { code: 'hu',    bcp47: 'hu-HU',    englishName: 'Hungarian',            nativeName: 'Magyar' },
  { code: 'fil',   bcp47: 'fil-PH',   englishName: 'Filipino',             nativeName: 'Filipino' },
  { code: 'sw',    bcp47: 'sw-KE',    englishName: 'Swahili',              nativeName: 'Kiswahili' },
];