import * as Yup from 'yup';
import { startOfHour, parseISO, isBefore, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';
import Appointment from '../models/Appointment';
import User from '../models/User';
import File from '../models/File';
import Notification from '../schemas/Notification';

import Cancellation from '../jobs/CancellationMail';
import Queue from '../../lib/Queue';

class AppointmentController {
  async index(req, res) {
    const { page = 1 } = req.query;

    const appointments = await Appointment.findAll({
      where: {
        user_id: req.userId,
        canceled_at: null,
      },
      attributes: ['id', 'date', 'past', 'cancelable'],
      order: ['date'],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url'],
            },
          ],
        },
      ],
    });

    if (!appointments) {
      return res.status(400).json({ error: 'O Usuário não tem agendamento' });
    }

    return res.json(appointments);
  }

  async store(req, res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    });

    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: 'Campos inválidos' });
    }
    const { provider_id, date } = req.body;

    // checke if provider_id is provider
    const isProvider = await User.findOne({
      where: { id: provider_id, provider: true },
    });

    if (provider_id === req.userId) {
      return res.status(401).json({
        error: 'Não é permitido criar Agendamentos para você mesmo',
      });
    }

    if (!isProvider) {
      return res.status(401).json({
        error: 'Não é permitido criar Agendamentos com esse provider',
      });
    }

    const hourStart = startOfHour(parseISO(date));

    // Check for past dates
    if (isBefore(hourStart, new Date())) {
      return res.status(400).json({
        error: 'Não é permitido datas menores que a data de hoje',
      });
    }

    // Check data availability
    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date: hourStart,
      },
    });

    if (checkAvailability) {
      return res
        .status(400)
        .json({ error: 'O agendamento não está disponível para essa data' });
    }

    const appointments = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date,
    });

    // Notify appointment provider
    const user = await User.findByPk(req.userId);
    const formatDate = format(hourStart, "'dia' dd 'de' MMMM 'às' H:mm'h", {
      locale: pt,
    });

    await Notification.create({
      content: `Novo agendamento de ${user.name} para o ${formatDate}`,
      user: provider_id,
    });

    return res.json(appointments);
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email'],
        },
        {
          model: User,
          as: 'user',
          attributes: ['name'],
        },
      ],
    });

    if (appointment.user_id !== req.userId) {
      return res
        .status(401)
        .json({ error: 'Você não tem permissão para cancelar um agendamento' });
    }

    const dataWithSub = subHours(appointment.date, 2);

    if (isBefore(dataWithSub, new Date())) {
      return res.status(401).json('Não é possível cancelar o agendamento');
    }

    appointment.canceled_at = new Date();

    await appointment.save();

    Queue.add(Cancellation.key, { appointment });

    return res.json(appointment);
  }
}

export default new AppointmentController();
