/**
 * RecepAI Availability Engine v1.0
 * Calculates doctor availability based on:
 * - Clinic hours
 * - Doctor schedule
 * - Breaks & lunch
 * - Blocks (vacation, congress, etc)
 * - Existing appointments
 * - Service duration + buffer
 */

'use strict';

const storage = require('./storage');
const clinicConfig = require('./clinicConfig');

const DAY_NAMES = ['duminica','luni','marti','miercuri','joi','vineri','sambata'];

const availability = {

  // ── GET AVAILABLE SLOTS FOR A DAY ──
  getSlots(clientId, doctorId, date, serviceDuration = 30) {
    const dateObj = new Date(date);
    const dayName = DAY_NAMES[dateObj.getDay()];
    const config = clinicConfig.get(clientId);
    // Get doctor
    const doctor = this._getDoctor(clientId, doctorId);
    if (!doctor) return { error: 'Doctor negăsit', slots: [] };

    // Check clinic is open
    const clinicDay = config.clinicHours?.[dayName];
    if (!clinicDay?.active) return { open: false, reason: 'Clinica închisă', slots: [] };

    // Check doctor works this day
    const doctorDay = doctor.schedule?.[dayName];
    if (!doctorDay?.active) return { open: false, reason: 'Doctorul nu lucrează', slots: [] };

    // Get existing appointments for this doctor on this date
    const dateStr = dateObj.toISOString().split('T')[0];
    const appointments = storage.getAppointments(clientId)
      .filter(a => a.doctor?.id === doctorId && a.date?.startsWith(dateStr) && a.status !== 'cancelled');

    // Build occupied slots
    const occupied = appointments.map(a => ({
      start: this._timeToMin(a.slot),
      end: this._timeToMin(a.slot) + (a.service?.durProc || 30) + (a.service?.durClean || 10) + (a.service?.durBuffer || 0),
    }));

    // Check blocks
    const blocked = this._isBlocked(doctor, dateStr);
    if (blocked) return { open: false, reason: blocked, slots: [] };

    // Generate slots
    const startMin = this._timeToMin(doctorDay.start || clinicDay.open || '09:00');
    const endMin = this._timeToMin(doctorDay.end || clinicDay.close || '18:00');
    const slotDur = serviceDuration + (config.booking?.bufferBetween || 10);
    const lastSlot = endMin - serviceDuration - (config.booking?.lastSlotBefore || 0);

    // Lunch break
    const breakStart = doctor.breakStart ? this._timeToMin(doctor.breakStart) : null;
    const breakEnd = doctor.breakEnd ? this._timeToMin(doctor.breakEnd) : null;

    const slots = [];
    for (let t = startMin; t <= lastSlot; t += config.booking?.slotDuration || 30) {
      // Skip lunch break
      if (breakStart && breakEnd && t >= breakStart && t < breakEnd) continue;

      // Skip if occupied
      const slotEnd = t + slotDur;
      const isBusy = occupied.some(o => t < o.end && slotEnd > o.start);
      if (isBusy) continue;

      slots.push({
        time: this._minToTime(t),
        available: true,
        doctorId,
        doctorName: doctor.name,
      });
    }

    return {
      open: true,
      date: dateStr,
      doctorId,
      doctorName: doctor.name,
      doctorSpec: doctor.spec,
      slots,
      totalSlots: slots.length,
    };
  },

  // ── GET ALL AVAILABLE SLOTS FOR ALL DOCTORS ──
  getSlotsAllDoctors(clientId, date, serviceId, serviceDuration = 30) {
    const doctors = this._getDoctors(clientId);
    const results = [];

    for (const doc of doctors) {
      if (doc.status === 'inactive') continue;
      // Filter by service if serviceId provided
      if (serviceId && doc.serviceIds?.length && !doc.serviceIds.includes(serviceId)) continue;

      const result = this.getSlots(clientId, doc.id, date, serviceDuration);
      if (result.open && result.slots.length > 0) {
        results.push(result);
      }
    }

    return results;
  },

  // ── GET NEXT N AVAILABLE DAYS ──
  getNextAvailableDays(clientId, doctorId, fromDate, count = 7, serviceDuration = 30) {
    const days = [];
    const d = new Date(fromDate);

    for (let i = 0; i < 30 && days.length < count; i++) {
      const dateStr = d.toISOString().split('T')[0];
      const result = this.getSlots(clientId, doctorId, dateStr, serviceDuration);
      if (result.open && result.slots.length > 0) {
        days.push({ date: dateStr, slots: result.slots.length, firstSlot: result.slots[0]?.time });
      }
      d.setDate(d.getDate() + 1);
    }

    return days;
  },

  // ── AI SCHEDULER — propune cele mai bune ore ──
  suggestSlots(clientId, serviceId, serviceDuration, preferredDate, preferredTime, count = 3) {
    const doctors = this._getDoctors(clientId);
    const suggestions = [];
    const startDate = preferredDate ? new Date(preferredDate) : new Date();

    for (let dayOffset = 0; dayOffset < 14 && suggestions.length < count; dayOffset++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + dayOffset);
      const dateStr = d.toISOString().split('T')[0];

      for (const doc of doctors) {
        if (doc.status === 'inactive') continue;
        if (serviceId && doc.serviceIds?.length && !doc.serviceIds.includes(serviceId)) continue;

        const result = this.getSlots(clientId, doc.id, dateStr, serviceDuration);
        if (!result.open || result.slots.length === 0) continue;

        // Find best slot (preferred time or first available)
        let bestSlot = result.slots[0];
        if (preferredTime) {
          const prefMin = this._timeToMin(preferredTime);
          bestSlot = result.slots.reduce((best, s) => {
            const diff = Math.abs(this._timeToMin(s.time) - prefMin);
            const bestDiff = Math.abs(this._timeToMin(best.time) - prefMin);
            return diff < bestDiff ? s : best;
          }, result.slots[0]);
        }

        suggestions.push({
          date: dateStr,
          dateFormatted: this._formatDate(d),
          time: bestSlot.time,
          doctorId: doc.id,
          doctorName: doc.name,
          doctorSpec: doc.spec,
          score: dayOffset === 0 ? 100 : 100 - dayOffset * 5,
        });

        if (suggestions.length >= count) break;
      }
    }

    return suggestions.sort((a, b) => b.score - a.score).slice(0, count);
  },

  // ── CHECK IF SLOT IS AVAILABLE ──
  isSlotAvailable(clientId, doctorId, date, time, serviceDuration) {
    const result = this.getSlots(clientId, doctorId, date, serviceDuration);
    return result.slots.some(s => s.time === time);
  },

  // ── HELPERS ──
  _timeToMin(time) {
    if (!time) return 0;
    const [h, m] = time.split(':').map(Number);
    return h * 60 + (m || 0);
  },

  _minToTime(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  },

  _isBlocked(doctor, dateStr) {
    for (const block of (doctor.blocks || [])) {
      if (dateStr >= block.start && dateStr <= block.end) {
        return block.reason || block.type || 'Blocat';
      }
    }
    return null;
  },

  _formatDate(d) {
    const days = ['Duminică','Luni','Marți','Miercuri','Joi','Vineri','Sâmbătă'];
    const months = ['Ian','Feb','Mar','Apr','Mai','Iun','Iul','Aug','Sep','Oct','Nov','Dec'];
    return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
  },

  _getDoctors(clientId) {
    try {
      const file = require('path').join(__dirname, '../data/doctors_' + clientId + '.json');
      const fs2 = require('fs');
      if (!fs2.existsSync(file)) return this._defaultDoctors();
      const content = fs2.readFileSync(file, 'utf8');
      if (!content.trim()) return this._defaultDoctors();
      return JSON.parse(content);
    } catch(e) {
      console.log('[AVAILABILITY] Using default doctors:', e.message);
      return this._defaultDoctors();
    }
  },

  _getDoctor(clientId, doctorId) {
    return this._getDoctors(clientId).find(d => d.id === doctorId) || null;
  },

  _defaultDoctors() {
    return [
      {
        id: 'd1', name: 'Dr. Andrei Popescu', spec: 'Implantologie',
        status: 'active', breakStart: '13:00', breakEnd: '14:00',
        schedule: {
          luni:{active:true,start:'09:00',end:'18:00'},
          marti:{active:true,start:'09:00',end:'18:00'},
          miercuri:{active:true,start:'09:00',end:'18:00'},
          joi:{active:true,start:'09:00',end:'18:00'},
          vineri:{active:true,start:'09:00',end:'14:00'},
          sambata:{active:false}, duminica:{active:false},
        },
        blocks: [],
      },
      {
        id: 'd2', name: 'Dr. Raluca Stan', spec: 'Ortodonție',
        status: 'active', breakStart: '13:00', breakEnd: '14:00',
        schedule: {
          luni:{active:true,start:'09:00',end:'19:00'},
          marti:{active:true,start:'09:00',end:'19:00'},
          miercuri:{active:false},
          joi:{active:true,start:'09:00',end:'19:00'},
          vineri:{active:true,start:'09:00',end:'19:00'},
          sambata:{active:true,start:'09:00',end:'13:00'},
          duminica:{active:false},
        },
        blocks: [],
      },
      {
        id: 'd3', name: 'Dr. Elena Maria', spec: 'Stomatologie',
        status: 'active', breakStart: '12:00', breakEnd: '13:00',
        schedule: {
          luni:{active:true,start:'08:00',end:'20:00'},
          marti:{active:true,start:'08:00',end:'20:00'},
          miercuri:{active:true,start:'08:00',end:'20:00'},
          joi:{active:true,start:'08:00',end:'20:00'},
          vineri:{active:true,start:'08:00',end:'20:00'},
          sambata:{active:false}, duminica:{active:false},
        },
        blocks: [],
      },
    ];
  },

  // ── SAVE DOCTORS ──
  saveDoctors(clientId, doctors) {
    const file = require('path').join(__dirname, '../data/doctors_' + clientId + '.json');
    require('fs').writeFileSync(file, JSON.stringify(doctors, null, 2));
    return doctors;
  },

  getDoctors(clientId) {
    return this._getDoctors(clientId);
  },
};

module.exports = availability;
