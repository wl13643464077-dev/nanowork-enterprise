import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3107';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': apiProxyTarget },
  },
  preview: {
    proxy: { '/api': apiProxyTarget },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // 拆 vendor：框架 / UI 库 / 图表各自成块，业务代码变更不再打爆整包缓存；
        // xlsx 走动态 import()，只有用户点导入/导出时才加载
        // 注意：antd 不整体分组——那会把 Table/DatePicker 等原本按路由懒加载的
        // 组件全部拽进启动路径，首屏反而变大；保持 antd 由构建器按共享关系自动拆
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/ },
            { name: 'vendor-echarts', test: /node_modules[\\/](echarts|zrender)[\\/]/ },
          ],
        },
      },
    },
  },
});
