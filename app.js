(function () {
  'use strict';

  var STATUS_OPTIONS = ['Não iniciado', 'Em andamento', 'Concluído', 'Travado'];

  var state = {
    tasks: [],
    marcos: [],
    weeks: [],
    loaded: false,
    editMode: false,
    passphrase: null,
    selectedWeekIndex: 0,
  };

  // ---------- utils ----------

  function parseISODate(s) {
    if (!s) return null;
    var parts = s.split('-');
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }

  function addDays(date, days) {
    var d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function fmtShort(date) {
    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm;
  }

  function fmtFull(date) {
    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + date.getFullYear();
  }

  function statusClass(status) {
    var map = {
      'Não iniciado': 'status-nao-iniciado',
      'Em andamento': 'status-em-andamento',
      'Concluído': 'status-concluido',
      'Travado': 'status-travado',
    };
    return map[status] || 'status-nao-iniciado';
  }

  function prioClass(p) {
    if (p === 'Alta') return 'pill-alta';
    if (p === 'Baixa') return 'pill-baixa';
    return 'pill-media';
  }

  function uniquePreserveOrder(arr) {
    var seen = {};
    var out = [];
    arr.forEach(function (v) {
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out;
  }

  var FRENTE_COLORS = ['red', 'blue', 'green', 'gold', 'teal', 'navy'];
  var frenteColorCache = {};
  function frenteColorClass(frente) {
    if (!frente) return 'red';
    if (frenteColorCache[frente]) return frenteColorCache[frente];
    var hash = 0;
    for (var i = 0; i < frente.length; i++) hash = (hash * 31 + frente.charCodeAt(i)) >>> 0;
    var cls = FRENTE_COLORS[hash % FRENTE_COLORS.length];
    frenteColorCache[frente] = cls;
    return cls;
  }

  function toast(message, isError) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  // ---------- data ----------

  function fetchData() {
    var url = CONFIG.API_URL + (CONFIG.API_URL.indexOf('?') >= 0 ? '&' : '?') + 'action=data';
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        state.tasks = data.tarefas || [];
        state.marcos = data.marcos || [];
        state.weeks = computeWeeks(state.tasks);
        state.loaded = true;
        document.getElementById('updatedAt').textContent =
          'atualizado ' + new Date(data.updatedAt).toLocaleTimeString('pt-BR');
        if (!state.tasks.length) {
          var debugUrl = CONFIG.API_URL + (CONFIG.API_URL.indexOf('?') >= 0 ? '&' : '?') + 'action=debug';
          document.getElementById('timeline').innerHTML =
            '<div class="state-msg">Conectei com o Apps Script, mas a base de tarefas voltou vazia. ' +
            'Normalmente é o script apontando para a planilha errada. Abra <a href="' + debugUrl + '" target="_blank" rel="noopener">esta URL de diagnóstico</a> ' +
            'e confira se o nome da planilha e as abas listadas são os certos.</div>';
        }
        renderAll();
      })
      .catch(function (err) {
        console.error(err);
        document.getElementById('updatedAt').textContent = 'erro ao carregar';
        document.getElementById('timeline').innerHTML =
          '<div class="state-msg error">Não consegui carregar os dados (' + escapeHtml(err.message || '') + '). Confira se a URL do Apps Script em config.js está correta e se foi implantada com acesso "Qualquer pessoa".</div>';
      });
  }

  function computeWeeks(tasks) {
    var start = parseISODate(CONFIG.WEEK_START);
    var weeks = [];
    for (var i = 0; i < CONFIG.N_WEEKS; i++) {
      var wStart = addDays(start, 7 * i);
      var wEnd = addDays(wStart, 6);
      var overlap = tasks.filter(function (t) {
        var ti = parseISODate(t.inicio), tf = parseISODate(t.fim);
        return ti && tf && ti <= wEnd && tf >= wStart;
      });
      var done = overlap.filter(function (t) { return t.status === 'Concluído'; }).length;
      weeks.push({
        index: i,
        label: 'Semana ' + (i + 1),
        start: wStart,
        end: wEnd,
        total: overlap.length,
        done: done,
        foco: uniquePreserveOrder(overlap.map(function (t) { return t.frente; })),
        entregas: uniquePreserveOrder(overlap.map(function (t) { return t.entregavel; })),
      });
    }
    return weeks;
  }

  function tasksInWeek(weekIndex) {
    var w = state.weeks[weekIndex];
    if (!w) return [];
    return state.tasks
      .filter(function (t) {
        var ti = parseISODate(t.inicio), tf = parseISODate(t.fim);
        return ti && tf && ti <= w.end && tf >= w.start;
      })
      .sort(function (a, b) { return parseISODate(a.inicio) - parseISODate(b.inicio); });
  }

  // ---------- API writes ----------

  function apiPost(payload) {
    payload.passphrase = state.passphrase;
    return fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); });
  }

  function updateTaskStatus(row, status, selectEl) {
    if (!state.editMode) return;
    var prev = selectEl ? selectEl.dataset.prev : null;
    apiPost({ action: 'updateStatus', row: row, status: status }).then(function (res) {
      if (res.error) {
        toast('Não consegui salvar: ' + res.error, true);
        if (selectEl && prev) selectEl.value = prev;
        return;
      }
      var t = state.tasks.find(function (x) { return x.row === row; });
      if (t) t.status = status;
      state.weeks = computeWeeks(state.tasks);
      toast('Status atualizado.');
      renderAll();
    }).catch(function () { toast('Erro de conexão ao salvar.', true); });
  }

  function updateMarcoStatus(row, status) {
    if (!state.editMode) return;
    apiPost({ action: 'updateMarcoStatus', row: row, status: status }).then(function (res) {
      if (res.error) { toast('Não consegui salvar: ' + res.error, true); return; }
      var m = state.marcos.find(function (x) { return x.row === row; });
      if (m) m.status = status;
      toast('Status do marco atualizado.');
      renderMarcos();
    }).catch(function () { toast('Erro de conexão ao salvar.', true); });
  }

  function addTask(task) {
    return apiPost({ action: 'addTask', task: task }).then(function (res) {
      if (res.error) { toast('Não consegui adicionar: ' + res.error, true); return false; }
      toast('Tarefa adicionada.');
      return fetchData().then(function () { return true; });
    }).catch(function () { toast('Erro de conexão.', true); return false; });
  }

  // ---------- render: cronograma ----------

  function renderCronograma() {
    var el = document.getElementById('timeline');
    if (!state.weeks.length) { el.innerHTML = '<div class="state-msg">Nenhuma tarefa cadastrada ainda.</div>'; return; }
    el.innerHTML = state.weeks.map(function (w) {
      var pct = w.total ? Math.round((w.done / w.total) * 100) : 0;
      var cls = w.total === 0 ? 'status-empty' : (w.done === w.total ? 'status-done' : 'status-progress');
      var focoTags = w.foco.length
        ? w.foco.map(function (f) { return '<span class="tag tag-' + frenteColorClass(f) + '">' + escapeHtml(f) + '</span>'; }).join('')
        : '<span class="tag">—</span>';
      var entregasTxt = w.entregas.length ? w.entregas.join(' • ') : '—';
      return (
        '<div class="week-node ' + cls + '" data-week="' + w.index + '">' +
          '<div class="week-head">' +
            '<span class="week-title">' + w.label + '</span>' +
            '<span class="week-period">' + fmtShort(w.start) + ' – ' + fmtShort(w.end) + '</span>' +
          '</div>' +
          '<div class="week-foco">' + focoTags + '</div>' +
          '<div class="week-entregas">' + escapeHtml(entregasTxt) + '</div>' +
          '<div class="week-progress-row">' +
            '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
            '<span class="progress-label">' + w.done + ' de ' + w.total + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    el.querySelectorAll('.week-node').forEach(function (node) {
      node.addEventListener('click', function () {
        state.selectedWeekIndex = parseInt(node.dataset.week, 10);
        switchView('semana');
      });
    });
  }

  // ---------- render: semana ----------

  function populateWeekSelect() {
    var sel = document.getElementById('weekSelect');
    sel.innerHTML = state.weeks.map(function (w) {
      return '<option value="' + w.index + '">' + w.label + '</option>';
    }).join('');
    sel.value = state.selectedWeekIndex;
  }

  function renderSemana() {
    populateWeekSelect();
    var w = state.weeks[state.selectedWeekIndex];
    if (!w) return;
    document.getElementById('weekPeriod').textContent = fmtFull(w.start) + ' a ' + fmtFull(w.end);
    document.getElementById('weekSummary').innerHTML = '<b>' + w.done + ' de ' + w.total + '</b> tarefas concluídas';

    var tasks = tasksInWeek(state.selectedWeekIndex);
    var container = document.getElementById('weekTasks');
    if (!tasks.length) {
      container.innerHTML = '<div class="state-msg">Nenhuma tarefa cadastrada nesta semana.</div>';
      return;
    }
    container.innerHTML = tasks.map(taskCardHtml).join('');
    bindStatusSelects(container);
  }

  function taskCardHtml(t) {
    var di = parseISODate(t.inicio), df = parseISODate(t.fim);
    return (
      '<div class="task-card">' +
        '<div class="task-card-head">' +
          '<div>' +
            '<div class="task-frente c-' + frenteColorClass(t.frente) + '">' + escapeHtml(t.frente) + '</div>' +
            '<div class="task-name">' + escapeHtml(t.tarefa) + '</div>' +
            '<div class="task-entregavel">' + escapeHtml(t.entregavel || '') + '</div>' +
          '</div>' +
          '<div class="task-dates">' + fmtShort(di) + ' – ' + fmtShort(df) + '</div>' +
        '</div>' +
        '<div class="task-meta">' +
          '<span class="pill ' + prioClass(t.prioridade) + '">' + escapeHtml(t.prioridade || '—') + '</span>' +
          statusSelectHtml(t.row, t.status) +
        '</div>' +
        (t.dependencia ? '<div class="task-dep">Depende de: ' + escapeHtml(t.dependencia) + '</div>' : '') +
      '</div>'
    );
  }

  function statusSelectHtml(row, status) {
    var opts = STATUS_OPTIONS.map(function (s) {
      return '<option value="' + s + '"' + (s === status ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    var disabled = state.editMode ? '' : 'disabled';
    return '<select class="status-select ' + statusClass(status) + '" data-row="' + row + '" data-prev="' + status + '" ' + disabled + '>' + opts + '</select>';
  }

  function bindStatusSelects(scope) {
    scope.querySelectorAll('.status-select[data-row]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var row = parseInt(sel.dataset.row, 10);
        sel.className = 'status-select ' + statusClass(sel.value);
        updateTaskStatus(row, sel.value, sel);
      });
    });
  }

  // ---------- render: marcos ----------

  function renderMarcos() {
    var el = document.getElementById('marcosRow');
    if (!state.marcos.length) { el.innerHTML = '<div class="state-msg">Nenhum marco cadastrado.</div>'; return; }
    el.innerHTML = state.marcos.map(function (m) {
      var opts = STATUS_OPTIONS.map(function (s) {
        return '<option value="' + s + '"' + (s === m.status ? ' selected' : '') + '>' + s + '</option>';
      }).join('');
      var disabled = state.editMode ? '' : 'disabled';
      return (
        '<div class="marco-card">' +
          '<div class="marco-periodo">' + escapeHtml(m.periodo) + '</div>' +
          '<h3>' + escapeHtml(m.marco) + '</h3>' +
          '<p>' + escapeHtml(m.pronto) + '</p>' +
          (m.margem && m.margem !== '—' ? '<div class="margem">Margem: ' + escapeHtml(m.margem) + '</div>' : '') +
          '<div style="margin-top:10px">' +
            '<select class="status-select ' + statusClass(m.status) + '" data-marco-row="' + m.row + '" ' + disabled + '>' + opts + '</select>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    el.querySelectorAll('select[data-marco-row]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var row = parseInt(sel.dataset.marcoRow, 10);
        sel.className = 'status-select ' + statusClass(sel.value);
        updateMarcoStatus(row, sel.value);
      });
    });
  }

  // ---------- render: tarefas ----------

  function renderTarefas() {
    var body = document.getElementById('tarefasBody');
    if (!state.tasks.length) {
      body.innerHTML = '<tr><td colspan="8" class="state-msg">Nenhuma tarefa cadastrada ainda.</td></tr>';
      return;
    }
    var sorted = state.tasks.slice().sort(function (a, b) { return parseISODate(a.inicio) - parseISODate(b.inicio); });
    body.innerHTML = sorted.map(function (t) {
      var di = parseISODate(t.inicio), df = parseISODate(t.fim);
      return (
        '<tr>' +
          '<td class="col-date" data-label="Início">' + fmtFull(di) + '</td>' +
          '<td class="col-date" data-label="Fim">' + fmtFull(df) + '</td>' +
          '<td data-label="Frente"><span class="task-frente c-' + frenteColorClass(t.frente) + '" style="margin:0">' + escapeHtml(t.frente) + '</span></td>' +
          '<td data-label="Tarefa">' + escapeHtml(t.tarefa) + '</td>' +
          '<td data-label="Entregável">' + escapeHtml(t.entregavel || '') + '</td>' +
          '<td data-label="Prioridade"><span class="pill ' + prioClass(t.prioridade) + '">' + escapeHtml(t.prioridade || '—') + '</span></td>' +
          '<td data-label="Status">' + statusSelectHtml(t.row, t.status) + '</td>' +
          '<td data-label="Dependência">' + escapeHtml(t.dependencia || '') + '</td>' +
        '</tr>'
      );
    }).join('');
    bindStatusSelects(body);
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderAll() {
    renderCronograma();
    renderSemana();
    renderMarcos();
    renderTarefas();
    syncAddTaskForm();
  }

  // ---------- tabs ----------

  function switchView(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + name);
    });
  }

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });

  document.getElementById('weekSelect').addEventListener('change', function (e) {
    state.selectedWeekIndex = parseInt(e.target.value, 10);
    renderSemana();
  });

  // ---------- edit mode ----------

  var passModal = document.getElementById('passModal');
  var passInput = document.getElementById('passInput');
  var passError = document.getElementById('passError');

  document.getElementById('editToggle').addEventListener('click', function () {
    if (state.editMode) {
      state.editMode = false;
      state.passphrase = null;
      sessionStorage.removeItem('cria_capao_pass');
      updateEditUI();
      renderAll();
      toast('Voltou pro modo visualização.');
    } else {
      passError.hidden = true;
      passInput.value = '';
      passModal.hidden = false;
      passInput.focus();
    }
  });

  document.getElementById('passCancel').addEventListener('click', function () { passModal.hidden = true; });

  document.getElementById('passConfirm').addEventListener('click', confirmPassphrase);
  passInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmPassphrase(); });

  function confirmPassphrase() {
    var pass = passInput.value;
    if (!pass) return;
    // A senha real só é validada no servidor quando você de fato salva algo.
    // Aqui já liberamos os controles; se a senha estiver errada, o primeiro
    // salvamento vai falhar com um aviso claro.
    state.passphrase = pass;
    state.editMode = true;
    sessionStorage.setItem('cria_capao_pass', pass);
    passModal.hidden = true;
    updateEditUI();
    renderAll();
    toast('Modo edição ativado.');
  }

  function updateEditUI() {
    var btn = document.getElementById('editToggle');
    var label = document.getElementById('editToggleLabel');
    btn.classList.toggle('active', state.editMode);
    label.textContent = state.editMode ? 'Modo edição' : 'Modo visualização';
  }

  function syncAddTaskForm() {
    document.getElementById('addTaskLocked').hidden = state.editMode;
    document.getElementById('addTaskForm').hidden = !state.editMode;
  }

  document.getElementById('addTaskForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(e.target);
    var task = {
      inicio: fd.get('inicio'), fim: fd.get('fim'), frente: fd.get('frente'),
      tarefa: fd.get('tarefa'), entregavel: fd.get('entregavel'),
      prioridade: fd.get('prioridade'), status: fd.get('status'), dependencia: fd.get('dependencia'),
    };
    if (!task.inicio || !task.fim || !task.tarefa) { toast('Preencha início, fim e tarefa.', true); return; }
    var btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    addTask(task).then(function (ok) {
      btn.disabled = false;
      if (ok) e.target.reset();
    });
  });

  // ---------- boot ----------

  var savedPass = sessionStorage.getItem('cria_capao_pass');
  if (savedPass) { state.passphrase = savedPass; state.editMode = true; }
  updateEditUI();
  fetchData();
})();
