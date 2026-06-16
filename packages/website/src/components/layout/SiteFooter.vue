<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-left">
        <div class="footer-brand">
          <img src="/logo.png" :alt="t('brand.logoAlt')" class="footer-logo" />
          <span>{{ t('brand.name') }}</span>
        </div>
        <p class="footer-desc">{{ t('footer.description') }}</p>
      </div>
      <div class="footer-right">
        <p class="footer-meta">{{ t('footer.madeWith') }}</p>
        <p class="footer-meta">{{ t('footer.license') }}</p>
      </div>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.site-footer {
  padding: 0 18px 18px;
  background: #f7f8fa;

  @media (max-width: $breakpoint-mobile) {
    padding: 0 10px 10px;
  }
}

.footer-inner {
  max-width: 1120px;
  margin: 0 auto;
  padding: 28px 32px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 40px;
  border: 1px solid rgba(30, 50, 90, 0.08);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.66);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.84);
  backdrop-filter: blur(14px);

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
    gap: 24px;
    padding: 22px 18px;
    border-radius: 22px;
  }
}

.footer-left {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 650;
  color: rgba(30, 38, 52, 0.9);
}

.footer-logo {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: #f7f4ef;
  border: 1px solid rgba(30, 50, 90, 0.08);
}

.footer-desc {
  color: rgba(42, 50, 64, 0.58);
  font-size: 13px;
}

.footer-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;

  @media (max-width: $breakpoint-mobile) {
    align-items: flex-start;
  }
}

.footer-meta {
  color: rgba(42, 50, 64, 0.58);
  font-size: 13px;
}

</style>
