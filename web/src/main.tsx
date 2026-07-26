import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './theme.css';

dayjs.locale('zh-cn');

const PALETTES: Record<string, any> = {
  nano: { primary: '#1769d2', bg: '#f3f6fa', surface: '#ffffff', elevated: '#ffffff', text: '#18263a', text2: '#586a80', border: '#dfe7f1', border2: '#e9eef5', selected: '#e8f1fc', selectedText: '#125ab4' },
  midnight: { primary: '#67a8f6', bg: '#071525', surface: '#0e2138', elevated: '#122942', text: '#eef6ff', text2: '#adc1d8', border: '#233b55', border2: '#1a314a', selected: 'rgba(75,145,229,.18)', selectedText: '#8fc0fb' },
};

const THEME_KEY = 'nanowork_industry_theme_v1';

function Root() {
  const [uiTheme, setUiTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'nano');
  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
    const onTheme = (event: Event) => setUiTheme((event as CustomEvent).detail?.theme || localStorage.getItem(THEME_KEY) || 'nano');
    window.addEventListener('nanowork-theme-change', onTheme);
    return () => window.removeEventListener('nanowork-theme-change', onTheme);
  }, [uiTheme]);
  const p = PALETTES[uiTheme] || PALETTES.nano;
  return <ConfigProvider locale={zhCN} theme={{
    algorithm: uiTheme === 'midnight' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.primary, borderRadius: 10, colorBgLayout: p.bg, colorBgContainer: p.surface,
      colorBgElevated: p.elevated, colorText: p.text, colorTextSecondary: p.text2,
      colorBorder: p.border, colorBorderSecondary: p.border2, colorInfo: p.primary,
      colorLink: p.primary, colorLinkHover: p.selectedText, fontSize: 13,
      fontFamily: "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
    },
    components: { Menu: { itemSelectedBg: p.selected, itemSelectedColor: p.selectedText, itemHeight: 42, iconSize: 15 } },
  }}><AppErrorBoundary><App /></AppErrorBoundary></ConfigProvider>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
