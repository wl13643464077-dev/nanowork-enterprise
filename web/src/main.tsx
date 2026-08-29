import React, { useEffect, useLayoutEffect, useState } from 'react';
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
  nano: {
    primary: '#2f6bda',
    bg: '#f5f6f4',
    surface: '#ffffff',
    elevated: '#ffffff',
    text: '#1d232b',
    text2: '#5e6875',
    border: '#e2e5e1',
    border2: '#eceeeb',
    selected: '#eaf1ff',
    selectedText: '#2558b7',
  },
  midnight: {
    primary: '#67a8f6',
    bg: '#071525',
    surface: '#0e2138',
    elevated: '#122942',
    text: '#eef6ff',
    text2: '#adc1d8',
    border: '#233b55',
    border2: '#1a314a',
    selected: 'rgba(75,145,229,.18)',
    selectedText: '#8fc0fb',
  },
};

const THEME_KEY = 'nanowork_industry_theme_v1';
const DEFAULT_THEME = 'nano';

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored && PALETTES[stored] ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

// 图表会在首次 passive effect 中解析 CSS 变量；React 挂载前先写入主题，
// 避免首屏按未命中的默认变量初始化后再闪烁或缓存错误色值。
const initialTheme = readTheme();
document.documentElement.dataset.theme = initialTheme;

function Root() {
  const [uiTheme, setUiTheme] = useState(initialTheme);

  // 主题 DOM 状态必须先于子组件的 passive effect（尤其是 ECharts setOption）落地。
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
  }, [uiTheme]);

  useEffect(() => {
    const onTheme = (event: Event) => {
      const requested = (event as CustomEvent).detail?.theme;
      setUiTheme(requested && PALETTES[requested] ? requested : readTheme());
    };
    window.addEventListener('nanowork-theme-change', onTheme);
    return () => window.removeEventListener('nanowork-theme-change', onTheme);
  }, []);
  const p = PALETTES[uiTheme] || PALETTES.nano;
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: uiTheme === 'midnight' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: p.primary,
          borderRadius: 9,
          colorBgLayout: p.bg,
          colorBgContainer: p.surface,
          colorBgElevated: p.elevated,
          colorText: p.text,
          colorTextSecondary: p.text2,
          colorBorder: p.border,
          colorBorderSecondary: p.border2,
          colorInfo: p.primary,
          colorLink: p.primary,
          colorLinkHover: p.selectedText,
          fontSize: 14,
          fontFamily: "'Inter Variable','Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
        },
        components: {
          Menu: { itemSelectedBg: p.selected, itemSelectedColor: p.selectedText, itemHeight: 42, iconSize: 15 },
        },
      }}
    >
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
