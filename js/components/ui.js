import { scrollToUnderHeader } from "../lib/scroll.js";

export function initUI() {
  return {
    productGrid: document.getElementById("productGrid"),
    emptyState: document.getElementById("emptyState"),

    modalOverlay: document.getElementById("modalOverlay"),
    modalBody: document.getElementById("modalBody"),
    modalClose: document.getElementById("modalClose"),

    cartPanel: document.getElementById("cartPanel"),
    cartBtn: document.getElementById("cartBtn"),
    cartClose: document.getElementById("cartClose"),
    cartOverlay: document.getElementById("cartOverlay"),
    cartItems: document.getElementById("cartItems"),
    cartTotal: document.getElementById("cartTotal"),
    cartCount: document.getElementById("cartCount"),
    cartEmptyMsg: document.getElementById("cartEmptyMsg"),
    whatsappBtn: document.getElementById("whatsappBtn"),

    filterChips: document.querySelectorAll(".filter-chip"),
    filtersToggle: document.getElementById("filtersToggle"),
    filtersContent: document.getElementById("filtersContent"),
  };
}

export function initHeaderScroll() {
  const header = document.querySelector('.site-header');

  if (!header) return;

  window.addEventListener('scroll', () => {
    if (window.scrollY > 10) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  });
}

export function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;

  toast.classList.remove("visible");

  void toast.offsetWidth;

  toast.classList.add("visible");

  setTimeout(() => {
    toast.classList.remove("visible");
  }, 2000);
}

export function initFooter(UI) {
  document.getElementById("footerAllProducts")?.addEventListener("click", (e) => {
    e.preventDefault();

    scrollToUnderHeader(document.getElementById("productos"));

    document.querySelectorAll(".filter-chip").forEach(btn => {
      btn.classList.remove("active");

      if (btn.dataset.category === "all") {
        btn.classList.add("active");
        btn.click();
      }
    });
  });

  // contacto
  document.getElementById("footerContacto")?.addEventListener("click", (e) => {
    e.preventDefault();
  });

}

export function initContactModal() {
  const modal = document.getElementById("contactModal");
  const overlay = document.getElementById("contactOverlay");
  const close = document.getElementById("contactClose");

  const openBtns = [
    document.getElementById("footerContacto"),
    document.querySelector('.header-nav a[href="#"]') 
  ];

  function openModal() {
    modal.classList.add("open");
  }

  function closeModal() {
    modal.classList.remove("open");
  }

  openBtns.forEach(btn => {
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openModal();
    });
  });

  close.addEventListener("click", closeModal);
  overlay.addEventListener("click", closeModal);
}

export function initFiltersToggle(UI) {

  if (!UI.filtersToggle || !UI.filtersContent) return;

  UI.filtersToggle.onclick = () => {
    UI.filtersToggle.classList.toggle("open");
    UI.filtersContent.classList.toggle("open");
  };

  // cerrar cuando se selecciona filtro (mobile)
  // (también para los botones de categorías que se agregan después de cargar)
  UI.filtersContent.addEventListener("click", (e) => {
    if (!e.target.closest(".filter-chip")) return;
    UI.filtersContent.classList.remove("open");
    UI.filtersToggle.classList.remove("open");
  });

}

export function initAboutModal() {
  const overlay = document.getElementById("aboutOverlay");
  const close = document.getElementById("aboutClose");

  const headerBtn = document.getElementById("headerAbout");
  const footerBtn = document.getElementById("footerAbout");

  function openModal() {
    overlay.classList.add("open");
  }

  function closeModal() {
    overlay.classList.remove("open");
  }

  headerBtn?.addEventListener("click", openModal);
  footerBtn?.addEventListener("click", openModal);

  close?.addEventListener("click", closeModal);

  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
}

export function initMobileMenu() {

  const menu = document.getElementById("mobileMenu");
  const openBtn = document.getElementById("menuBtn");
  const closeBtn = document.getElementById("mobileMenuClose");
  const overlay = document.getElementById("mobileMenuOverlay");

  const contacto = document.getElementById("mobileContacto");
  const about = document.getElementById("mobileAbout");

  function open() {
    menu.classList.add("open");
  }

  function close() {
    menu.classList.remove("open");
  }

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  overlay?.addEventListener("click", close);

  // abrir modales
  contacto?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    document.getElementById("footerContacto")?.click();
  });

  about?.addEventListener("click", (e) => {
    e.preventDefault();
    close();
    document.getElementById("headerAbout")?.click();
  });
}