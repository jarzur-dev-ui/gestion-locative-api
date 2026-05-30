import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { closeMailer } from '../lib/mailer.js';
import { closePdfBrowser } from '../lib/pdf-renderer.js';
import { runDailyRentPeriodTasks } from './rent-periods.task.js';

let scheduledTasks: cron.ScheduledTask[] = [];

export function startScheduler(): void {
  // Tous les jours à 08:00 Europe/Paris
  // - Crée les rent_periods du mois prochain pour chaque bail actif (idempotent)
  // - Envoie les avis d'échéance pour les périodes draft dont due_date <= J+10
  const dailyTask = cron.schedule(
    '0 8 * * *',
    async () => {
      const startedAt = Date.now();
      logger.info('scheduler: daily rent-period task — start');
      try {
        const result = await runDailyRentPeriodTasks();
        logger.info(
          { ...result, durationMs: Date.now() - startedAt },
          'scheduler: daily rent-period task — done',
        );
      } catch (err) {
        logger.error({ err }, 'scheduler: daily rent-period task — failed');
      }
    },
    { timezone: 'Europe/Paris' },
  );

  scheduledTasks.push(dailyTask);
  logger.info('scheduler: démarré (1 tâche quotidienne 08:00 Europe/Paris)');
}

export async function stopScheduler(): Promise<void> {
  for (const task of scheduledTasks) {
    task.stop();
  }
  scheduledTasks = [];
  await Promise.allSettled([closePdfBrowser(), closeMailer()]);
  logger.info('scheduler: arrêté + browser + mailer fermés');
}
