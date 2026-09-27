import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import Home from './views/Home.vue'
import Report from './views/Report.vue'
import './style.css'

const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/', component: Home },
  { path: '/runs/:id', component: Report, props: true }
] })
createApp(App).use(router).mount('#app')
