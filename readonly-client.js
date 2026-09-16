/**
 * Browser read-only status collector for the ops UI.
 * Talks to a public Redbelly JSON-RPC (CORS *) with ethers v5. No wallet, no signing key.
 */
(function (global) {
  const BPS_DENOMINATOR = 10000;
  const DEBT_ABI = [
    'function securityToken() view returns (address)',
    'function cashToken() view returns (address)',
    'function maturity() view returns (uint256)',
    'function couponRateBps() view returns (uint256)',
    'function defaulted() view returns (bool)',
    'function defaultReason() view returns (bytes32)',
    'function positionOf(address investor) view returns (tuple(uint256 principal, uint256 accrued, uint256 lastAccrual, bool redeemed))',
    'function previewAccrual(address investor) view returns (uint256 accruedTotal, uint256 delta)',
  ];
  const TOKEN_ABI = [
    'function identityRegistry() view returns (address)',
    'function balanceOf(address account) view returns (uint256)',
  ];
  const IR_ABI = [
    'function contains(address user) view returns (bool)',
    'function identity(address user) view returns (address)',
    'function isVerified(address user) view returns (bool)',
  ];
  const CASH_ABI = ['function balanceOf(address account) view returns (uint256)'];
  const NEXT_COPY = {
    register: {
      title: 'Register',
      summary: 'This investor is not eligible yet. Finish KYC off-chain, then register them on the identity registry. Ops can Issue after that.',
    },
    issue: {
      title: 'Issue',
      summary: 'Investor is eligible. Issue their position on this loan. The ops key signs; there is no investor wallet prompt.',
    },
    accrue: {
      title: 'Accrue',
      summary: 'Position is open. Accrue coupon interest (actual/365). The amount can stay $0 until enough time passes.',
    },
    'pay-coupon': {
      title: 'Coupon',
      summary: 'Coupon is due. Pay it from the ops cash wallet to this investor (push payment).',
    },
    redeem: {
      title: 'Redeem',
      summary: 'This loan has reached maturity. Redeem to repay principal plus any remaining coupon.',
    },
    'idle-redeemed': {
      title: 'Redeemed',
      summary: 'This position is fully redeemed. Point the page at a new loan to continue.',
    },
    'blocked-defaulted': {
      title: 'Defaulted',
      summary: 'This loan is in default. Coupon and redeem are blocked. Deploy a new instrument to continue the demo.',
    },
    'redeploy-matured': {
      title: 'New instrument',
      summary: 'This loan is past maturity with no position, so Issue cannot run. Deploy a new PrivateDebt and paste the address here.',
    },
  };

  function ethersLib() {
    if (!global.ethers) {
      throw new Error('ethers failed to load from CDN. Check the network and retry.');
    }
    return global.ethers;
  }

  function groupThousands(digits) {
    const negative = digits.startsWith('-');
    const abs = negative ? digits.slice(1) : digits;
    const grouped = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return negative ? `-${grouped}` : grouped;
  }

  function formatUsdFromWei(wei, decimals) {
    const ethers = ethersLib();
    const raw = ethers.utils.formatUnits(ethers.BigNumber.from(wei), decimals);
    const parts = raw.split('.');
    const wholeFmt = groupThousands(parts[0]);
    const frac = parts[1] || '';
    const fracTrim = frac.replace(/0+$/, '');
    if (!fracTrim) {
      return `$${wholeFmt}`;
    }
    const cents = `${fracTrim}00`.slice(0, 2);
    return `$${wholeFmt}.${cents}`;
  }

  function moneyView(wei, decimals) {
    const ethers = ethersLib();
    return {
      display: formatUsdFromWei(wei, decimals),
      wei: ethers.BigNumber.from(wei).toString(),
    };
  }

  function usdToWei(usd, decimals) {
    return ethersLib().utils.parseUnits(usd, decimals);
  }

  function targetPrincipalWei(note, investor, decimals) {
    return usdToWei(note.faceValueUsd, decimals).mul(investor.targetShareBps).div(BPS_DENOMINATOR);
  }

  function shareBps(part, whole) {
    const ethers = ethersLib();
    const denom = ethers.BigNumber.from(whole);
    if (denom.lte(0)) {
      return 0;
    }
    return ethers.BigNumber.from(part).mul(BPS_DENOMINATOR).div(denom).toNumber();
  }

  function formatShareBps(bps) {
    const whole = Math.floor(bps / 100);
    const frac = bps % 100;
    if (frac === 0) {
      return `${whole}%`;
    }
    return `${whole}.${frac.toString().padStart(2, '0')}%`;
  }

  function formatActualShare(principal, bps) {
    const ethers = ethersLib();
    if (ethers.BigNumber.from(principal).lte(0)) {
      return '—';
    }
    if (bps <= 0) {
      return '<0.01%';
    }
    return formatShareBps(bps);
  }

  function formatCouponRate(bps) {
    const ethers = ethersLib();
    const value = ethers.BigNumber.from(bps).toNumber();
    const whole = Math.floor(value / 100);
    const frac = value % 100;
    if (frac === 0) {
      return `${whole}%`;
    }
    return `${whole}.${frac.toString().padStart(2, '0')}%`;
  }

  function truncateAddress(address) {
    if (!address || address.length < 12) {
      return address || '—';
    }
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }

  function explorerAddress(explorer, address) {
    return `${explorer.replace(/\/$/, '')}/address/${address}`;
  }

  function iso(seconds) {
    return new Date(seconds * 1000).toISOString();
  }

  function link(explorer, address) {
    return { address, explorer: explorerAddress(explorer, address) };
  }

  function findById(rows, id, fallbackIndex) {
    if (!id) {
      return rows[fallbackIndex];
    }
    const found = rows.find((row) => row.id === id);
    if (!found) {
      throw new Error(`Unknown id: ${id}`);
    }
    return found;
  }

  function nextOpsAction(snapshot) {
    if (snapshot.defaulted) {
      return { id: 'blocked-defaulted', summary: NEXT_COPY['blocked-defaulted'].summary };
    }
    if (snapshot.redeemed) {
      return { id: 'idle-redeemed', summary: NEXT_COPY['idle-redeemed'].summary };
    }
    if (!snapshot.hasPrincipal) {
      if (snapshot.matured) {
        return { id: 'redeploy-matured', summary: NEXT_COPY['redeploy-matured'].summary };
      }
      if (!snapshot.registered || !snapshot.verified) {
        return { id: 'register', summary: NEXT_COPY.register.summary };
      }
      return { id: 'issue', summary: NEXT_COPY.issue.summary };
    }
    if (snapshot.matured) {
      return { id: 'redeem', summary: NEXT_COPY.redeem.summary };
    }
    if (snapshot.couponDue) {
      return { id: 'pay-coupon', summary: NEXT_COPY['pay-coupon'].summary };
    }
    return { id: 'accrue', summary: NEXT_COPY.accrue.summary };
  }

  function adminNextFromAction(action) {
    const copy = NEXT_COPY[action.id] || { title: action.id, summary: action.summary };
    return { id: action.id, title: copy.title, summary: copy.summary };
  }

  function emptyButtons() {
    return { issue: false, accrue: false, coupon: false, redeem: false, default: false };
  }

  function decodeReason(reason) {
    const ethers = ethersLib();
    if (!reason || reason === ethers.constants.HashZero) {
      return '';
    }
    try {
      return ethers.utils.parseBytes32String(reason);
    } catch (err) {
      return '';
    }
  }

  function noteAddress(note, overrides) {
    const session = overrides && overrides[note.id];
    if (session) {
      return { address: session, source: 'env' };
    }
    if (note.privateDebt) {
      return { address: note.privateDebt, source: 'config' };
    }
    return { address: '', source: 'unset' };
  }

  function pendingInvestorRow(config, note, investor, explorer, selected) {
    const decimals = config.dollarScale.decimals;
    const target = moneyView(targetPrincipalWei(note, investor, decimals), decimals);
    const zero = moneyView(0, decimals);
    return {
      id: investor.id,
      label: investor.label,
      address: investor.address,
      addressShort: truncateAddress(investor.address),
      explorer: explorerAddress(explorer, investor.address),
      eligibility: 'pending',
      registered: false,
      verified: false,
      identity: investor.identity || null,
      identityExplorer: investor.identity ? explorerAddress(explorer, investor.identity) : null,
      position: zero,
      accrued: zero,
      redeemed: false,
      positionShareBps: 0,
      positionShare: '—',
      target,
      targetShareBps: investor.targetShareBps,
      targetShare: formatShareBps(investor.targetShareBps),
      tokenBalance: zero,
      cashBalance: zero,
      selected,
    };
  }

  async function hasCode(provider, address) {
    if (!address) {
      return false;
    }
    const code = await provider.getCode(address);
    return Boolean(code) && code !== '0x';
  }

  async function noteStatusRow(provider, config, note, explorer, overrides) {
    const resolved = noteAddress(note, overrides);
    const faceValue = moneyView(usdToWei(note.faceValueUsd, config.dollarScale.decimals), config.dollarScale.decimals);
    if (!resolved.address) {
      return {
        id: note.id,
        label: note.label,
        faceValue,
        privateDebt: null,
        addressShort: null,
        explorer: null,
        deployed: false,
        source: 'unset',
      };
    }
    const ethers = ethersLib();
    const checksum = ethers.utils.getAddress(resolved.address);
    const deployed = await hasCode(provider, checksum);
    return {
      id: note.id,
      label: note.label,
      faceValue,
      privateDebt: checksum,
      addressShort: truncateAddress(checksum),
      explorer: explorerAddress(explorer, checksum),
      deployed,
      source: resolved.source,
    };
  }

  async function readInvestorRow(ctx, config, note, investor, selected) {
    const ethers = ethersLib();
    const decimals = config.dollarScale.decimals;
    const faceWei = usdToWei(note.faceValueUsd, decimals);
    const target = moneyView(targetPrincipalWei(note, investor, decimals), decimals);
    let registered = false;
    let verified = false;
    let identity = ethers.constants.AddressZero;
    try {
      registered = await ctx.ir.contains(investor.address);
      verified = registered ? await ctx.ir.isVerified(investor.address) : false;
      if (registered) {
        identity = await ctx.ir.identity(investor.address);
      }
    } catch (err) {
      registered = false;
      verified = false;
    }
    const position = await ctx.debt.positionOf(investor.address);
    const tokenBalance = await ctx.token.balanceOf(investor.address);
    const cashBalance = await ctx.cash.balanceOf(investor.address);
    const identitySet = identity !== ethers.constants.AddressZero;
    const configuredIdentity = investor.identity;
    let identityExplorer = null;
    if (identitySet) {
      identityExplorer = explorerAddress(ctx.explorer, identity);
    } else if (configuredIdentity) {
      identityExplorer = explorerAddress(ctx.explorer, configuredIdentity);
    }
    const principal = position.principal;
    const positionShare = shareBps(principal, faceWei);
    return {
      id: investor.id,
      label: investor.label,
      address: investor.address,
      addressShort: truncateAddress(investor.address),
      explorer: explorerAddress(ctx.explorer, investor.address),
      eligibility: verified ? 'verified' : 'pending',
      registered,
      verified,
      identity: identitySet ? identity : configuredIdentity || null,
      identityExplorer,
      position: moneyView(principal, decimals),
      accrued: moneyView(position.accrued, decimals),
      redeemed: Boolean(position.redeemed),
      positionShareBps: ethers.BigNumber.from(principal).gt(0) ? positionShare : 0,
      positionShare: formatActualShare(principal, positionShare),
      target,
      targetShareBps: investor.targetShareBps,
      targetShare: formatShareBps(investor.targetShareBps),
      tokenBalance: moneyView(tokenBalance, decimals),
      cashBalance: moneyView(cashBalance, decimals),
      selected,
    };
  }

  async function loadEthers() {
    if (global.ethers) {
      return global.ethers;
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load ethers from CDN. Open in Safari/Chrome with network access.'));
      document.head.appendChild(script);
    });
    if (!global.ethers) {
      throw new Error('ethers failed to load from CDN. Check the network and retry.');
    }
    return global.ethers;
  }

  async function loadDemoConfig() {
    const res = await fetch('demo-config.json', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error('Could not load demo-config.json');
    }
    return res.json();
  }

  async function collectOpsStatus(config, query) {
    const ethers = ethersLib();
    const note = findById(config.notes, query && query.noteId, 0);
    const investor = findById(config.investors, query && query.investorId, 0);
    const explorer = config.explorer;
    const overrides = (query && query.noteOverrides) || {};
    const provider = new ethers.providers.JsonRpcProvider(config.rpc, config.chainId);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== Number(config.chainId)) {
      throw new Error(`Expected chainId ${config.chainId}, RPC reported ${net.chainId}`);
    }
    const notes = await Promise.all(config.notes.map((row) => noteStatusRow(provider, config, row, explorer, overrides)));
    const selectedNote = notes.find((row) => row.id === note.id);
    const decimals = config.dollarScale.decimals;
    const issueAmount = moneyView(targetPrincipalWei(note, investor, decimals), decimals);
    const pendingRows = config.investors.map((row) => pendingInvestorRow(config, note, row, explorer, row.id === investor.id));

    const undeployed = {
      custodyModel: 'A',
      readOnly: true,
      selectedNoteId: note.id,
      selectedInvestorId: investor.id,
      notes,
      investors: pendingRows,
      next: {
        id: 'register',
        title: 'Not deployed yet',
        summary: `${note.label} is not deployed yet. Paste a PrivateDebt address to inspect it.`,
      },
      buttons: emptyButtons(),
      deployed: false,
      undeployedReason: `${note.label} is not deployed yet.`,
      register: {
        contained: false,
        verified: false,
        identity: ethers.constants.AddressZero,
        identityExplorer: null,
      },
      links: {
        opsSigner: link(explorer, config.opsAddress),
        investor: link(explorer, investor.address),
        privateDebt: selectedNote.privateDebt ? link(explorer, selectedNote.privateDebt) : null,
        token: null,
        cash: null,
        ir: null,
      },
      privateDebtSource: selectedNote.source,
      instrument: {
        couponRate: '—',
        couponRateBps: '',
        maturity: 0,
        maturityIso: '',
        chainTime: 0,
        chainTimeIso: '',
        matured: false,
        defaulted: false,
        defaultReason: '',
        defaultReasonDecoded: '',
        faceValue: selectedNote.faceValue,
      },
      position: null,
      principalToIssue: issueAmount,
      verifiedCount: 0,
      pendingCount: config.investors.length,
    };

    if (!selectedNote.deployed) {
      return undeployed;
    }

    const resolved = noteAddress(note, overrides);
    const debt = new ethers.Contract(resolved.address, DEBT_ABI, provider);
    const tokenAddress = await debt.securityToken();
    const cashAddress = await debt.cashToken();
    const token = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
    const cash = new ethers.Contract(cashAddress, CASH_ABI, provider);
    const irAddress = await token.identityRegistry();
    const ir = new ethers.Contract(irAddress, IR_ABI, provider);
    const ctx = { debt, token, cash, ir, explorer };
    const latest = await provider.getBlock('latest');
    const maturity = (await debt.maturity()).toNumber();
    const couponRateBps = await debt.couponRateBps();
    const investors = await Promise.all(config.investors.map((row) => readInvestorRow(ctx, config, note, row, row.id === investor.id)));
    const selectedRow = investors.find((row) => row.id === investor.id);
    const position = await debt.positionOf(investor.address);
    const preview = await debt.previewAccrual(investor.address);
    const previewTotal = preview.accruedTotal !== undefined ? preview.accruedTotal : preview[0];
    const previewDelta = preview.delta !== undefined ? preview.delta : preview[1];
    const defaulted = await debt.defaulted();
    const snapshot = {
      registered: selectedRow.registered,
      verified: selectedRow.verified,
      defaulted,
      redeemed: Boolean(position.redeemed),
      hasPrincipal: ethers.BigNumber.from(position.principal).gt(0),
      couponDue: ethers.BigNumber.from(previewTotal).gt(0),
      matured: latest.timestamp >= maturity,
    };
    const next = adminNextFromAction(nextOpsAction(snapshot));
    const defaultReason = defaulted ? await debt.defaultReason() : ethers.constants.HashZero;
    const opsCash = await cash.balanceOf(config.opsAddress);
    const verifiedCount = investors.filter((row) => row.verified).length;

    return {
      custodyModel: 'A',
      readOnly: true,
      selectedNoteId: note.id,
      selectedInvestorId: investor.id,
      notes,
      investors,
      next,
      buttons: emptyButtons(),
      deployed: true,
      undeployedReason: null,
      register: {
        contained: selectedRow.registered,
        verified: selectedRow.verified,
        identity: selectedRow.identity || ethers.constants.AddressZero,
        identityExplorer: selectedRow.identityExplorer,
      },
      links: {
        opsSigner: link(explorer, config.opsAddress),
        investor: link(explorer, investor.address),
        privateDebt: link(explorer, resolved.address),
        token: link(explorer, tokenAddress),
        cash: link(explorer, cashAddress),
        ir: link(explorer, irAddress),
      },
      privateDebtSource: resolved.source,
      instrument: {
        couponRate: formatCouponRate(couponRateBps),
        couponRateBps: couponRateBps.toString(),
        maturity,
        maturityIso: iso(maturity),
        chainTime: latest.timestamp,
        chainTimeIso: iso(latest.timestamp),
        matured: snapshot.matured,
        defaulted,
        defaultReason,
        defaultReasonDecoded: decodeReason(defaultReason),
        faceValue: selectedNote.faceValue,
      },
      position: {
        principal: moneyView(position.principal, decimals),
        accrued: moneyView(position.accrued, decimals),
        lastAccrual: ethers.BigNumber.from(position.lastAccrual).toString(),
        lastAccrualIso: ethers.BigNumber.from(position.lastAccrual).gt(0)
          ? iso(ethers.BigNumber.from(position.lastAccrual).toNumber())
          : null,
        redeemed: Boolean(position.redeemed),
        previewTotal: moneyView(previewTotal, decimals),
        previewDelta: moneyView(previewDelta, decimals),
        tokenBalance: selectedRow.tokenBalance,
        cashBalance: selectedRow.cashBalance,
        opsCash: moneyView(opsCash, decimals),
      },
      principalToIssue: issueAmount,
      verifiedCount,
      pendingCount: investors.length - verifiedCount,
    };
  }

  global.OpsReadonly = {
    loadEthers,
    loadDemoConfig,
    collectOpsStatus,
    checksum: function checksum(address) {
      return ethersLib().utils.getAddress(address);
    },
  };
})(window);
