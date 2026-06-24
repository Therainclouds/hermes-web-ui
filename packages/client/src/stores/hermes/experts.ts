import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as expertsApi from '@/api/hermes/experts'
import type {
  ExpertCatalogItem,
  ExpertDetail,
  ExpertManifest,
  ExpertProfileBindingRow,
  InstalledExpertRow,
  MarketplaceConfig,
} from '@/api/hermes/experts'

export type ExpertTab = 'published' | 'team' | 'installed'

export const useExpertsStore = defineStore('experts', () => {
  const config = ref<MarketplaceConfig | null>(null)
  const catalog = ref<ExpertCatalogItem[]>([])
  const installed = ref<InstalledExpertRow[]>([])
  const bindings = ref<ExpertProfileBindingRow[]>([])
  const detailBySlug = ref<Record<string, ExpertDetail>>({})
  const manifestByKey = ref<Record<string, ExpertManifest>>({})
  const loading = ref(false)
  const installing = ref(false)
  const upgrading = ref<string | null>(null)
  const uninstalling = ref<string | null>(null)
  const lastError = ref<string | null>(null)

  function manifestKey(slug: string, version: string) {
    return `${slug}@${version}`
  }

  async function fetchConfig() {
    try {
      config.value = await expertsApi.fetchMarketplaceConfig()
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'config 读取失败'
    }
  }

  async function fetchCatalog() {
    loading.value = true
    try {
      catalog.value = await expertsApi.fetchCatalog()
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'catalog 读取失败'
    } finally {
      loading.value = false
    }
  }

  async function refreshCatalog() {
    loading.value = true
    try {
      catalog.value = await expertsApi.refreshCatalog()
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'catalog 刷新失败'
    } finally {
      loading.value = false
    }
  }

  async function fetchDetail(slug: string) {
    if (detailBySlug.value[slug]) return detailBySlug.value[slug]
    try {
      const d = await expertsApi.fetchDetail(slug)
      detailBySlug.value[slug] = d
      return d
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'detail 读取失败'
      return null
    }
  }

  async function fetchManifest(slug: string, version: string) {
    const key = manifestKey(slug, version)
    if (manifestByKey.value[key]) return manifestByKey.value[key]
    try {
      const m = await expertsApi.fetchManifest(slug, version)
      manifestByKey.value[key] = m
      return m
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'manifest 读取失败'
      return null
    }
  }

  async function fetchInstalled() {
    loading.value = true
    try {
      const r = await expertsApi.fetchInstalled()
      installed.value = r.installed
      bindings.value = r.bindings
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'installed 读取失败'
    } finally {
      loading.value = false
    }
  }

  async function install(slug: string, version: string) {
    installing.value = true
    lastError.value = null
    try {
      const r = await expertsApi.installExpert({ slug, version })
      await fetchInstalled()
      return r
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'install 失败'
      throw err
    } finally {
      installing.value = false
    }
  }

  async function upgrade(slug: string) {
    upgrading.value = slug
    lastError.value = null
    try {
      const r = await expertsApi.upgradeExpert(slug)
      await fetchInstalled()
      return r
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'upgrade 失败'
      throw err
    } finally {
      upgrading.value = null
    }
  }

  async function uninstall(slug: string) {
    uninstalling.value = slug
    lastError.value = null
    try {
      const r = await expertsApi.uninstallExpert(slug)
      await fetchInstalled()
      return r
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'uninstall 失败'
      throw err
    } finally {
      uninstalling.value = null
    }
  }

  function findInstalled(slug: string): InstalledExpertRow | undefined {
    return installed.value.find((it) => it.expert_slug === slug)
  }

  function bindingsForProfile(profileName: string): ExpertProfileBindingRow | undefined {
    return bindings.value.find((b) => b.profile_name === profileName)
  }

  return {
    config,
    catalog,
    installed,
    bindings,
    detailBySlug,
    manifestByKey,
    loading,
    installing,
    upgrading,
    uninstalling,
    lastError,
    fetchConfig,
    fetchCatalog,
    refreshCatalog,
    fetchDetail,
    fetchManifest,
    fetchInstalled,
    install,
    upgrade,
    uninstall,
    findInstalled,
    bindingsForProfile,
  }
})
