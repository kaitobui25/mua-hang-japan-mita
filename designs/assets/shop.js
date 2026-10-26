(() => {
  const catalog = [
    { id: "dhc", brand: "DHC", name: "Vitamin C 60 ngày", jp: "ビタミンC", category: "supplements", need: "vitamin", image: "dhc-c.jpg", note: "Thực phẩm bổ sung" },
    { id: "meiji", brand: "Meiji", name: "Sữa Hohoemi dạng viên", jp: "ほほえみ らくらくキューブ", category: "baby-food", need: "baby", image: "meiji-cube.jpg", note: "Sữa công thức cho bé" },
    { id: "pigeon", brand: "Pigeon", name: "Sữa dưỡng da em bé", jp: "ベビーミルクローション", category: "baby-care", need: "baby", image: "pigeon-lotion.jpg", note: "Chăm sóc da bé" },
    { id: "agney", brand: "agney*", name: "Bộ bát và thìa ăn dặm", jp: "もぐもぐ離乳食セット", category: "baby-food", need: "baby", image: "baby-feeding.webp", note: "Đồ dùng ăn dặm" },
    { id: "10mois", brand: "10mois", name: "Bộ đồ ăn cho bé", jp: "mamamanma ギフトセット", category: "baby-care", need: "baby", image: "baby-gift.jpg", note: "Đồ dùng cho bé" },
    { id: "alobaby", brand: "ALOBABY", name: "Sữa tắm dịu nhẹ cho bé", jp: "ベビーソープ", category: "baby-care", need: "baby", image: "alobaby.jpg", note: "Chăm sóc da bé" },
    { id: "bebeton", brand: "Bebeton", name: "Túi ngủ cotton cho bé", jp: "ベビースリーパー", category: "baby-care", need: "baby", image: "baby-sleeper.png", note: "Đồ dùng cho bé" }
  ];
  const categories = {
    all: "Tất cả sản phẩm",
    supplements: "Thực phẩm bổ sung",
    "baby-food": "Sữa & ăn dặm",
    "baby-care": "Chăm sóc bé"
  };
  const state = { category: "all", term: "", sort: "default", wishlist: new Set(), request: [] };
  const assetPath = "../assets/";
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const grid = document.querySelector("[data-product-grid]");
  const count = document.querySelector("[data-results-count]");
  const dialog = document.createElement("dialog");
  dialog.className = "request-dialog";
  dialog.innerHTML = `
    <div class="dialog-header">
      <div><h2>Danh sách yêu cầu</h2><p>Đây là bản demo. Chưa có yêu cầu nào được gửi.</p></div>
      <button class="icon-button dialog-close" type="button" aria-label="Đóng">×</button>
    </div>
    <div data-request-items></div>
    <div class="dialog-footer"><p>Giá bán, phí vận chuyển và tình trạng hàng cần được xác minh khi báo giá.</p><button class="btn btn-secondary dialog-done" type="button">Tiếp tục xem hàng</button></div>
  `;
  document.body.append(dialog);

  function productCard(p) {
    const liked = state.wishlist.has(p.id);
    return `<article class="product-card">
      <div class="product-visual">
        <img loading="lazy" width="480" height="480" src="${assetPath + p.image}" alt="${escapeHtml(p.brand + " " + p.name)}">
        <button type="button" class="favorite-button ${liked ? "is-active" : ""}" data-favorite="${p.id}" aria-label="${liked ? "Bỏ yêu thích" : "Lưu yêu thích"} ${escapeHtml(p.name)}" aria-pressed="${liked}">${liked ? "♥" : "♡"}</button>
      </div>
      <div class="product-info">
        <p class="product-brand">${escapeHtml(p.brand)} <span>${escapeHtml(p.note)}</span></p>
        <h3>${escapeHtml(p.name)}</h3>
        <p class="product-jp" lang="ja">${escapeHtml(p.jp)}</p>
        <div class="product-foot"><span class="quote-label">Giá cần xác nhận</span><button type="button" class="add-button" data-add="${p.id}" aria-label="Thêm ${escapeHtml(p.name)} vào yêu cầu">Thêm yêu cầu <span aria-hidden="true">+</span></button></div>
      </div>
    </article>`;
  }

  function render() {
    if (!grid) return;
    const q = state.term.trim().toLocaleLowerCase("vi");
    let matches = catalog.filter(p => {
      const categoryMatch = state.category === "all" || p.category === state.category;
      const queryMatch = !q || `${p.name} ${p.brand} ${p.jp} ${p.note}`.toLocaleLowerCase("vi").includes(q);
      return categoryMatch && queryMatch;
    });
    if (state.sort === "az") matches = [...matches].sort((a, b) => a.name.localeCompare(b.name, "vi"));
    if (state.sort === "za") matches = [...matches].sort((a, b) => b.name.localeCompare(a.name, "vi"));
    grid.innerHTML = matches.length ? matches.map(productCard).join("") : `<div class="empty-results"><h3>Chưa tìm thấy sản phẩm</h3><p>Thử từ khóa ngắn hơn hoặc chọn danh mục khác.</p><button type="button" class="btn btn-secondary" data-reset>Tất cả sản phẩm</button></div>`;
    if (count) count.textContent = `${matches.length} sản phẩm minh họa`;
    document.querySelectorAll("[data-category]").forEach(button => {
      const active = button.dataset.category === state.category;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const label = document.querySelector("[data-active-category]");
    if (label) label.textContent = categories[state.category];
    updateCartBadge();
  }

  function updateCartBadge() {
    document.querySelectorAll("[data-cart-count]").forEach(e => e.textContent = String(state.request.reduce((sum, item) => sum + item.qty, 0)));
  }

  function renderRequest() {
    const container = dialog.querySelector("[data-request-items]");
    if (!state.request.length) {
      container.innerHTML = '<div class="request-empty">Chưa có sản phẩm. Bạn có thể thêm hàng từ danh mục hoặc dán link Amazon Japan.</div>';
    } else {
      container.innerHTML = state.request.map(item => {
        const p = catalog.find(x => x.id === item.id);
        const name = p ? p.name : "Sản phẩm từ Amazon Japan";
        const secondary = p ? p.brand : item.id;
        return `<div class="request-line"><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(secondary)}</small></div><div class="qty-controls"><button data-decrease="${escapeHtml(item.id)}" aria-label="Giảm số lượng ${escapeHtml(name)}" type="button">−</button><span>${item.qty}</span><button data-increase="${escapeHtml(item.id)}" aria-label="Tăng số lượng ${escapeHtml(name)}" type="button">+</button></div></div>`;
      }).join("");
    }
    updateCartBadge();
  }

  function addRequest(id) {
    const row = state.request.find(i => i.id === id);
    if (row) row.qty++;
    else state.request.push({ id, qty: 1 });
    renderRequest();
    dialog.showModal();
  }

  document.addEventListener("click", event => {
    const category = event.target.closest("[data-category]");
    if (category) {
      state.category = category.dataset.category;
      state.term = "";
      document.querySelectorAll("[data-search-input]").forEach(e => e.value = "");
      render();
      document.querySelector("[data-product-section]")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const add = event.target.closest("[data-add]");
    if (add) addRequest(add.dataset.add);
    const favorite = event.target.closest("[data-favorite]");
    if (favorite) {
      state.wishlist.has(favorite.dataset.favorite) ? state.wishlist.delete(favorite.dataset.favorite) : state.wishlist.add(favorite.dataset.favorite);
      render();
    }
    if (event.target.closest("[data-cart-open]")) { renderRequest(); dialog.showModal(); }
    if (event.target.closest(".dialog-close, .dialog-done")) dialog.close();
    if (event.target.closest("[data-reset]")) { state.category = "all"; state.term = ""; render(); }
    const minus = event.target.closest("[data-decrease]");
    if (minus) {
      const row = state.request.find(i => i.id === minus.dataset.decrease);
      if (row) { row.qty--; if (row.qty < 1) state.request = state.request.filter(i => i !== row); renderRequest(); }
    }
    const plus = event.target.closest("[data-increase]");
    if (plus) { const row = state.request.find(i => i.id === plus.dataset.increase); if (row) { row.qty++; renderRequest(); } }
  });
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  document.querySelectorAll("[data-search-form]").forEach(form => form.addEventListener("submit", e => {
    e.preventDefault();
    state.term = form.querySelector("[data-search-input]").value;
    state.category = "all";
    render();
    document.querySelector("[data-product-section]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll("[data-search-input]").forEach(input => input.addEventListener("input", () => {
    state.term = input.value;
    state.category = "all";
    render();
  }));
  document.querySelectorAll("[data-sort]").forEach(select => select.addEventListener("change", e => { state.sort = e.target.value; render(); }));
  document.querySelectorAll("[data-amazon-form]").forEach(form => form.addEventListener("submit", event => {
    event.preventDefault();
    const input = form.querySelector("input");
    const output = form.querySelector("[data-amazon-error]");
    try {
      const url = new URL(input.value.trim());
      const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i);
      if (url.protocol !== "https:" || !/(^|\.)amazon\.co\.jp$/i.test(url.hostname) || !match) throw new Error();
      output.textContent = "Đã thêm link vào danh sách trên bản demo.";
      const id = match[1].toUpperCase();
      addRequest(id);
      input.value = "";
    } catch {
      output.textContent = "Hãy dán link sản phẩm Amazon.co.jp có mã ASIN hợp lệ.";
      input.focus();
    }
  }));
  render();
})();
